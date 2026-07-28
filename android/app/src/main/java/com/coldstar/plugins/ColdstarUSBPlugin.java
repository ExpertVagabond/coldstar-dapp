package com.coldstar.plugins;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Build;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.util.Log;

import android.content.UriPermission;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.util.HashMap;
import java.util.List;

/**
 * ColdstarUSB — Capacitor plugin for USB mass storage operations.
 *
 * Provides the Android-side USB Host API access for:
 * - Detecting connected USB mass storage devices
 * - Requesting permission for USB access
 * - Reading/writing files on USB storage
 * - Formatting/preparing USB drives for cold wallet use
 *
 * This mirrors the coldstar CLI flash_usb.py process for mobile.
 */
@CapacitorPlugin(name = "ColdstarUSB")
public class ColdstarUSBPlugin extends Plugin {

    private static final String TAG = "ColdstarUSB";
    private static final String ACTION_USB_PERMISSION = "com.coldstar.USB_PERMISSION";
    private static final String PREFS_NAME = "coldstar_usb";
    private static final String PREF_TREE_URI = "saf_tree_uri";

    private UsbManager usbManager;
    private PendingIntent permissionIntent;
    private PluginCall pendingPermissionCall;
    private Uri safTreeUri; // SAF-selected drive URI

    // The SAF tree URI is the access credential to the wallet drive, so it lives
    // in Keystore-backed EncryptedSharedPreferences (parity: iOS Keychain — see
    // PLATFORM-PARITY.md A1). Plaintext values from older builds migrate once.
    private SharedPreferences securePrefs;
    private boolean securePrefsEncrypted;

    private void initSecurePrefs() {
        try {
            MasterKey masterKey = new MasterKey.Builder(getContext())
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            securePrefs = EncryptedSharedPreferences.create(
                    getContext(),
                    PREFS_NAME + "_secure",
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
            securePrefsEncrypted = true;
        } catch (Exception e) {
            // Keystore unavailable (rare, broken devices). The drive URI is not the
            // key itself — the container stays PIN-encrypted — so degrade loudly
            // rather than brick the app.
            Log.e(TAG, "EncryptedSharedPreferences unavailable; falling back to plaintext prefs", e);
            securePrefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            securePrefsEncrypted = false;
        }
    }

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        Intent intent = new Intent(ACTION_USB_PERMISSION);
        intent.setPackage(getContext().getPackageName());

        int flags = PendingIntent.FLAG_IMMUTABLE;
        permissionIntent = PendingIntent.getBroadcast(getContext(), 0, intent, flags);

        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(usbReceiver, filter);
        }

        initSecurePrefs();

        // One-time migration: pre-A1 builds stored the URI in plaintext prefs.
        SharedPreferences legacy = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (securePrefsEncrypted) {
            String legacyUri = legacy.getString(PREF_TREE_URI, null);
            if (legacyUri != null) {
                if (!securePrefs.contains(PREF_TREE_URI)) {
                    securePrefs.edit().putString(PREF_TREE_URI, legacyUri).apply();
                }
                legacy.edit().remove(PREF_TREE_URI).apply();
                Log.i(TAG, "Migrated SAF tree URI from plaintext to encrypted prefs");
            }
        }

        // Restore persisted SAF tree URI
        String savedUri = securePrefs.getString(PREF_TREE_URI, null);
        if (savedUri != null) {
            safTreeUri = Uri.parse(savedUri);
            Log.d(TAG, "Restored SAF tree URI: " + safTreeUri);
        }
    }

    /**
     * Resolve the SAF root, verifying the persisted permission is still held and
     * the tree is usable. Returns null when access is stale/revoked — callers
     * must surface the "re-select the drive" message instead of a generic error.
     * (Parity: iOS stale-bookmark handling — PLATFORM-PARITY.md A3.)
     */
    private DocumentFile safRootOrNull() {
        if (safTreeUri == null) return null;

        boolean stillPersisted = false;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(safTreeUri) && p.isReadPermission() && p.isWritePermission()) {
                stillPersisted = true;
                break;
            }
        }
        if (!stillPersisted) {
            Log.w(TAG, "SAF permission no longer persisted for " + safTreeUri);
            return null;
        }

        DocumentFile root = DocumentFile.fromTreeUri(getContext(), safTreeUri);
        if (root == null || !root.exists() || !root.canWrite()) {
            Log.w(TAG, "SAF root missing or not writable: " + safTreeUri);
            return null;
        }
        return root;
    }

    private static final String STALE_SAF_ERROR =
            "USB drive access was revoked or the drive changed. Re-select the drive.";

    /**
     * List connected USB mass storage devices.
     * Checks USB Host API first, then falls back to StorageManager
     * and /storage/ mount points for broader compatibility.
     */
    @PluginMethod()
    public void listDevices(PluginCall call) {
        JSObject result = new JSObject();
        JSArray devices = new JSArray();

        try {
            // Method 1: USB Host API — checks for raw USB devices
            HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
            Log.d(TAG, "USB Host API found " + deviceList.size() + " device(s)");

            for (UsbDevice device : deviceList.values()) {
                boolean isMassStorage = false;
                for (int i = 0; i < device.getInterfaceCount(); i++) {
                    if (device.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_MASS_STORAGE) {
                        isMassStorage = true;
                        break;
                    }
                }

                Log.d(TAG, "USB device: " + device.getDeviceName()
                    + " class=" + (device.getInterfaceCount() > 0
                        ? device.getInterface(0).getInterfaceClass() : -1)
                    + " isMassStorage=" + isMassStorage);

                if (isMassStorage) {
                    JSObject dev = new JSObject();
                    dev.put("deviceId", device.getDeviceId());
                    dev.put("vendorId", device.getVendorId());
                    dev.put("productId", device.getProductId());
                    dev.put("deviceName", device.getDeviceName());

                    // These calls require USB permission on Android 10+
                    // and will throw SecurityException if not yet granted
                    String manufacturer = "Unknown";
                    String productName = "USB Mass Storage";
                    String serial = "";
                    try { manufacturer = device.getManufacturerName(); } catch (SecurityException ignored) {}
                    try { productName = device.getProductName(); } catch (SecurityException ignored) {}
                    try { serial = device.getSerialNumber(); } catch (SecurityException ignored) {}

                    dev.put("manufacturerName", manufacturer != null ? manufacturer : "Unknown");
                    dev.put("productName", productName != null ? productName : "USB Mass Storage");
                    dev.put("serialNumber", serial != null ? serial : "");
                    dev.put("devicePath", findUSBMountPoint());

                    long storageSize = getUSBStorageSize();
                    dev.put("storageSize", storageSize);
                    dev.put("formattedSize", formatSize(storageSize));

                    devices.put(dev);
                }
            }

            // Method 2: StorageManager — checks for removable mounted volumes
            // This catches USB drives that Android auto-mounts without going
            // through USB Host API (more common on modern Android)
            if (devices.length() == 0) {
                Log.d(TAG, "No USB Host API mass storage, checking StorageManager...");
                StorageManager sm = (StorageManager) getContext()
                        .getSystemService(Context.STORAGE_SERVICE);
                if (sm != null) {
                    List<StorageVolume> volumes = sm.getStorageVolumes();
                    for (int i = 0; i < volumes.size(); i++) {
                        StorageVolume vol = volumes.get(i);
                        Log.d(TAG, "StorageVolume: " + vol.getDescription(getContext())
                            + " removable=" + vol.isRemovable()
                            + " state=" + vol.getState());

                        if (vol.isRemovable() && "mounted".equals(vol.getState())) {
                            File dir = vol.getDirectory();
                            String mountPath = dir != null ? dir.getAbsolutePath() : null;
                            long size = dir != null ? dir.getTotalSpace() : 0;

                            JSObject dev = new JSObject();
                            dev.put("deviceId", 1000 + i);
                            dev.put("vendorId", 0);
                            dev.put("productId", 0);
                            dev.put("deviceName", vol.getDescription(getContext()));
                            dev.put("manufacturerName", "USB");
                            dev.put("productName", vol.getDescription(getContext()));
                            dev.put("serialNumber", vol.getUuid() != null ? vol.getUuid() : "");
                            dev.put("devicePath", mountPath != null ? mountPath : "");
                            dev.put("storageSize", size);
                            dev.put("formattedSize", formatSize(size));
                            devices.put(dev);
                        }
                    }
                }
            }

            // Method 3: Scan /storage/ for USB mount directories
            // Android mounts USB drives at /storage/<UUID>/ paths
            if (devices.length() == 0) {
                Log.d(TAG, "No StorageManager volumes, scanning /storage/...");
                File storageDir = new File("/storage");
                if (storageDir.exists()) {
                    File[] children = storageDir.listFiles();
                    if (children != null) {
                        for (File child : children) {
                            String name = child.getName();
                            // Skip emulated (internal), self, sdcard
                            if (name.equals("emulated") || name.equals("self")
                                    || name.equals("sdcard")) continue;

                            if (child.isDirectory() && child.canRead()) {
                                long size = child.getTotalSpace();
                                Log.d(TAG, "/storage/ found: " + name
                                    + " size=" + size + " canWrite=" + child.canWrite());

                                if (size > 0) {
                                    JSObject dev = new JSObject();
                                    dev.put("deviceId", 2000 + name.hashCode());
                                    dev.put("vendorId", 0);
                                    dev.put("productId", 0);
                                    dev.put("deviceName", "USB Drive (" + name + ")");
                                    dev.put("manufacturerName", "USB");
                                    dev.put("productName", "USB Drive");
                                    dev.put("serialNumber", name);
                                    dev.put("devicePath", child.getAbsolutePath());
                                    dev.put("storageSize", size);
                                    dev.put("formattedSize", formatSize(size));
                                    devices.put(dev);
                                }
                            }
                        }
                    }
                }
            }

            Log.d(TAG, "Total USB devices found: " + devices.length());

        } catch (Exception e) {
            Log.e(TAG, "Error listing USB devices", e);
        }

        result.put("devices", devices);
        call.resolve(result);
    }

    /**
     * Request permission to access a USB device.
     */
    @PluginMethod()
    public void requestPermission(PluginCall call) {
        int deviceId = call.getInt("deviceId", -1);

        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        UsbDevice targetDevice = null;

        for (UsbDevice device : deviceList.values()) {
            if (device.getDeviceId() == deviceId) {
                targetDevice = device;
                break;
            }
        }

        if (targetDevice == null) {
            JSObject result = new JSObject();
            result.put("granted", false);
            result.put("error", "Device not found");
            call.resolve(result);
            return;
        }

        if (usbManager.hasPermission(targetDevice)) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        // A second request must not silently orphan the first call's promise
        // (parity: iOS pickStorageLocation — PLATFORM-PARITY.md A2).
        if (pendingPermissionCall != null) {
            JSObject superseded = new JSObject();
            superseded.put("granted", false);
            superseded.put("error", "superseded by a newer permission request");
            pendingPermissionCall.resolve(superseded);
        }
        pendingPermissionCall = call;
        usbManager.requestPermission(targetDevice, permissionIntent);
    }

    /**
     * Prepare a USB drive for cold wallet use (unmount if needed).
     */
    @PluginMethod()
    public void prepareDrive(PluginCall call) {
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    /**
     * Format USB drive. On Android, we use the mounted filesystem
     * and create the directory structure directly rather than
     * reformatting (which requires root).
     */
    @PluginMethod()
    public void formatDrive(PluginCall call) {
        // On Android, we can't reformat USB without root.
        // Instead, we'll clean and create the directory structure.
        // Retry up to 5 times with 1-second delays since Android may still
        // be mounting the drive after USB detection.
        String mountPoint = null;
        for (int attempt = 0; attempt < 5; attempt++) {
            mountPoint = findUSBMountPoint();
            if (mountPoint != null) break;
            Log.d(TAG, "USB mount not found yet, retrying in 1s (attempt " + (attempt + 1) + "/5)");
            try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
        }

        // If filesystem mount not found, try SAF tree URI
        if (mountPoint == null && safTreeUri != null) {
            Log.d(TAG, "Using SAF tree URI for format: " + safTreeUri);
            try {
                DocumentFile root = safRootOrNull();
                if (root == null) {
                    JSObject result = new JSObject();
                    result.put("success", false);
                    result.put("error", STALE_SAF_ERROR);
                    result.put("needsManualSelection", true);
                    call.resolve(result);
                    return;
                }
                if (root.exists() && root.canWrite()) {
                    // Clean existing coldstar directories
                    String[] dirs = {"wallet", "inbox", "outbox", ".coldstar"};
                    for (String dirName : dirs) {
                        DocumentFile existing = root.findFile(dirName);
                        if (existing != null && existing.isDirectory()) {
                            existing.delete();
                        }
                    }

                    JSObject result = new JSObject();
                    result.put("success", true);
                    result.put("mountPoint", safTreeUri.toString());
                    result.put("usingSAF", true);
                    call.resolve(result);
                    return;
                }
            } catch (Exception e) {
                Log.e(TAG, "SAF format failed", e);
            }
        }

        if (mountPoint == null) {
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", "Could not find USB mount point. Use selectDriveLocation to manually select the USB drive.");
            result.put("needsManualSelection", true);
            call.resolve(result);
            return;
        }

        try {
            // Clean existing coldstar directories if present
            cleanDirectory(new File(mountPoint, "wallet"));
            cleanDirectory(new File(mountPoint, "inbox"));
            cleanDirectory(new File(mountPoint, "outbox"));
            cleanDirectory(new File(mountPoint, ".coldstar"));

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("mountPoint", mountPoint);
            call.resolve(result);
        } catch (Exception e) {
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", e.getMessage());
            call.resolve(result);
        }
    }

    /**
     * Create a directory on the USB drive.
     */
    @PluginMethod()
    public void createDirectory(PluginCall call) {
        String path = call.getString("path", "");
        String mountPoint = findUSBMountPoint();

        if (mountPoint != null) {
            File dir = new File(mountPoint, path);
            boolean created = dir.mkdirs();
            JSObject result = new JSObject();
            result.put("success", created || dir.exists());
            call.resolve(result);
            return;
        }

        // SAF fallback
        if (safTreeUri != null) {
            try {
                DocumentFile root = safRootOrNull();
                if (root == null) { call.reject(STALE_SAF_ERROR); return; }
                DocumentFile dir = findOrCreateSAFDirectory(root, path);
                JSObject result = new JSObject();
                result.put("success", dir != null);
                call.resolve(result);
                return;
            } catch (Exception e) {
                Log.e(TAG, "SAF createDirectory failed", e);
            }
        }

        call.reject("USB mount point not found");
    }

    /**
     * Write a file to the USB drive.
     */
    @PluginMethod()
    public void writeFile(PluginCall call) {
        String path = call.getString("path", "");
        String content = call.getString("content", "");
        String mountPoint = findUSBMountPoint();

        if (mountPoint != null) {
            File file = new File(mountPoint, path);

            // Ensure parent directory exists
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            try (FileWriter writer = new FileWriter(file)) {
                writer.write(content);
                writer.flush();

                JSObject result = new JSObject();
                result.put("success", true);
                // Explicit write confirmation (parity: iOS writeToOutbox — A6)
                result.put("bytesWritten", content.getBytes().length);
                call.resolve(result);
                return;
            } catch (IOException e) {
                call.reject("Failed to write file: " + e.getMessage());
                return;
            }
        }

        // SAF fallback
        if (safTreeUri != null) {
            try {
                DocumentFile root = safRootOrNull();
                if (root == null) { call.reject(STALE_SAF_ERROR); return; }
                // Navigate/create parent directories
                String parentPath = path.contains("/") ? path.substring(0, path.lastIndexOf('/')) : "";
                String fileName = path.contains("/") ? path.substring(path.lastIndexOf('/') + 1) : path;

                DocumentFile parentDir = parentPath.isEmpty() ? root : findOrCreateSAFDirectory(root, parentPath);
                if (parentDir == null) {
                    call.reject("Failed to create parent directory via SAF");
                    return;
                }

                // Delete existing file if present
                DocumentFile existing = parentDir.findFile(fileName);
                if (existing != null) existing.delete();

                DocumentFile newFile = parentDir.createFile("application/octet-stream", fileName);
                if (newFile == null) {
                    call.reject("Failed to create file via SAF");
                    return;
                }

                try (OutputStream os = getContext().getContentResolver().openOutputStream(newFile.getUri());
                     OutputStreamWriter writer = new OutputStreamWriter(os)) {
                    writer.write(content);
                    writer.flush();
                }

                JSObject result = new JSObject();
                result.put("success", true);
                result.put("bytesWritten", content.getBytes().length);
                call.resolve(result);
                return;
            } catch (Exception e) {
                call.reject("SAF write failed: " + e.getMessage());
                return;
            }
        }

        call.reject("USB mount point not found");
    }

    /**
     * Read a file from the USB drive.
     */
    @PluginMethod()
    public void readFile(PluginCall call) {
        String path = call.getString("path", "");
        String mountPoint = findUSBMountPoint();

        if (mountPoint != null) {
            File file = new File(mountPoint, path);

            if (!file.exists()) {
                call.reject("File not found: " + path);
                return;
            }

            try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
                StringBuilder content = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    content.append(line).append("\n");
                }

                JSObject result = new JSObject();
                result.put("content", content.toString().trim());
                call.resolve(result);
                return;
            } catch (IOException e) {
                call.reject("Failed to read file: " + e.getMessage());
                return;
            }
        }

        // SAF fallback
        if (safTreeUri != null) {
            try {
                DocumentFile root = safRootOrNull();
                if (root == null) { call.reject(STALE_SAF_ERROR); return; }
                DocumentFile file = findSAFFile(root, path);

                if (file == null || !file.exists()) {
                    call.reject("File not found: " + path);
                    return;
                }

                try (InputStream is = getContext().getContentResolver().openInputStream(file.getUri());
                     BufferedReader reader = new BufferedReader(new java.io.InputStreamReader(is))) {
                    StringBuilder content = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        content.append(line).append("\n");
                    }

                    JSObject result = new JSObject();
                    result.put("content", content.toString().trim());
                    call.resolve(result);
                    return;
                }
            } catch (Exception e) {
                call.reject("SAF read failed: " + e.getMessage());
                return;
            }
        }

        call.reject("USB mount point not found");
    }

    /**
     * Generate a wallet on the USB drive using the Rust FFI backend.
     */
    @PluginMethod()
    public void generateWallet(PluginCall call) {
        // This delegates to the Rust coldstar_generate_wallet FFI.
        // The PIN is collected on the frontend and passed here.
        String pin = call.getString("pin", "");

        if (pin.isEmpty()) {
            call.reject("PIN is required");
            return;
        }

        try {
            // Build JSON input for Rust FFI (expects {"pin": "...", "label": "..."})
            JSObject ffiInput = new JSObject();
            ffiInput.put("pin", pin);
            String resultJson = nativeGenerateWallet(ffiInput.toString());

            if (resultJson != null) {
                JSObject parsed = new JSObject(resultJson);
                if (parsed.optBoolean("success", false)) {
                    JSObject data = parsed.has("data") ? new JSObject(parsed.getJSONObject("data").toString()) : null;
                    if (data != null) {
                        JSObject result = new JSObject();
                        result.put("publicKey", data.getString("public_key"));
                        result.put("encryptedContainer",
                                data.getJSONObject("wallet").toString());
                        call.resolve(result);
                        return;
                    }
                }
            }

            call.reject("Wallet generation failed");
        } catch (Exception e) {
            Log.e(TAG, "Error generating wallet", e);
            call.reject("Wallet generation failed: " + e.getMessage());
        }
    }

    /**
     * Eject / safely unmount the USB drive.
     */
    @PluginMethod()
    public void ejectDrive(PluginCall call) {
        // Android doesn't provide a direct unmount API for USB.
        // At minimum, we sync filesystem buffers.
        try {
            Runtime.getRuntime().exec("sync");
            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (IOException e) {
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", e.getMessage());
            call.resolve(result);
        }
    }

    /**
     * Let the user manually select the USB drive location via Android's
     * Storage Access Framework. This is the fallback when auto-detection
     * of mount points fails (common on many Android devices).
     */
    @PluginMethod()
    public void selectDriveLocation(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "handleDriveSelection");
    }

    @ActivityCallback
    private void handleDriveSelection(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;

        if (activityResult.getResultCode() == Activity.RESULT_OK
                && activityResult.getData() != null) {
            Uri treeUri = activityResult.getData().getData();
            if (treeUri != null) {
                // Persist permission across reboots
                getContext().getContentResolver().takePersistableUriPermission(treeUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

                safTreeUri = treeUri;

                // Save to encrypted prefs (A1) — never the plaintext store
                securePrefs.edit()
                        .putString(PREF_TREE_URI, treeUri.toString())
                        .apply();

                Log.i(TAG, "SAF drive selected: " + treeUri);

                JSObject result = new JSObject();
                result.put("success", true);
                result.put("uri", treeUri.toString());
                call.resolve(result);
                return;
            }
        }

        JSObject result = new JSObject();
        result.put("success", false);
        result.put("error", "No drive location selected");
        call.resolve(result);
    }

    /**
     * Explicitly revoke the saved drive: release the persistable URI permission
     * and clear the stored URI (encrypted + legacy plaintext).
     * Parity: iOS forgetStorageLocation — PLATFORM-PARITY.md A5.
     */
    @PluginMethod()
    public void forgetDriveLocation(PluginCall call) {
        try {
            if (safTreeUri != null) {
                try {
                    getContext().getContentResolver().releasePersistableUriPermission(safTreeUri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (SecurityException e) {
                    // Already released / never persisted — clearing state is what matters
                    Log.w(TAG, "releasePersistableUriPermission: " + e.getMessage());
                }
            }
            safTreeUri = null;
            securePrefs.edit().remove(PREF_TREE_URI).apply();
            getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().remove(PREF_TREE_URI).apply();

            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to forget drive location: " + e.getMessage());
        }
    }

    // ─── Native FFI bridge ───

    /**
     * Call the Rust coldstar_generate_wallet function via JNI.
     */
    private native String nativeGenerateWallet(String pinJson);

    static {
        try {
            System.loadLibrary("coldstar_ffi");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load coldstar_ffi native library", e);
        }
    }

    // ─── Internal helpers ───

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (ACTION_USB_PERMISSION.equals(intent.getAction())) {
                boolean granted = intent.getBooleanExtra(
                        UsbManager.EXTRA_PERMISSION_GRANTED, false);

                if (pendingPermissionCall != null) {
                    JSObject result = new JSObject();
                    result.put("granted", granted);
                    pendingPermissionCall.resolve(result);
                    pendingPermissionCall = null;
                }
            }
        }
    };

    private String findUSBMountPoint() {
        // Method 1: StorageManager for removable volumes (most reliable)
        StorageManager sm = (StorageManager) getContext()
                .getSystemService(Context.STORAGE_SERVICE);
        if (sm != null) {
            List<StorageVolume> volumes = sm.getStorageVolumes();
            for (StorageVolume vol : volumes) {
                if (vol.isRemovable() && "mounted".equals(vol.getState())) {
                    File dir = vol.getDirectory();
                    if (dir != null && dir.exists()) {
                        Log.d(TAG, "Found USB mount via StorageManager: " + dir.getAbsolutePath());
                        return dir.getAbsolutePath();
                    }
                }
            }
        }

        // Method 2: Check common USB mount points (device-specific paths)
        // Includes MediaTek, Qualcomm, Samsung, and other vendor-specific paths
        String[] candidates = {
                "/storage/usb0",
                "/storage/usb1",
                "/storage/usb2",
                "/storage/usbdisk",
                "/storage/UsbDriveA",
                "/storage/UsbDriveB",
                "/storage/USBstorage1",
                "/storage/usbotg",
                "/storage/USB",
                "/storage/USB0",
                "/storage/USB1",
                "/mnt/usb_storage",
                "/mnt/usb_storage/USB_DISK0",
                "/mnt/usb_storage/USB_DISK1",
                "/mnt/usb",
                "/mnt/media_rw/usb",
                "/mnt/media_rw/usbotg",
                "/mnt/media_rw/USB",
                "/mnt/sdcard/usb_storage",
                "/sdcard/usbStorage",
        };

        for (String path : candidates) {
            File dir = new File(path);
            if (dir.exists() && dir.canRead() && dir.getTotalSpace() > 0) {
                Log.d(TAG, "Found USB mount at hardcoded path: " + path);
                return path;
            }
        }

        // Method 3: Scan /mnt/media_rw/ for USB mount directories
        // Android mounts USB OTG drives here internally before exposing via FUSE
        File mediaRwDir = new File("/mnt/media_rw");
        if (mediaRwDir.exists()) {
            File[] children = mediaRwDir.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (child.isDirectory() && child.canRead() && child.getTotalSpace() > 0) {
                        Log.d(TAG, "Found USB mount via /mnt/media_rw/ scan: " + child.getAbsolutePath());
                        return child.getAbsolutePath();
                    }
                }
            }
        }

        // Method 4: Scan /storage/ for UUID-based mount points
        File storageDir = new File("/storage");
        if (storageDir.exists()) {
            File[] children = storageDir.listFiles();
            if (children != null) {
                for (File child : children) {
                    String name = child.getName();
                    if (name.equals("emulated") || name.equals("self")
                            || name.equals("sdcard") || name.equals("sdcard0")) continue;
                    if (child.isDirectory() && child.canRead() && child.getTotalSpace() > 0) {
                        Log.d(TAG, "Found USB mount via /storage/ scan: " + child.getAbsolutePath());
                        return child.getAbsolutePath();
                    }
                }
            }
        }

        // Method 5: Parse /proc/mounts for USB filesystem mounts
        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/mounts"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String[] parts = line.split("\\s+");
                if (parts.length >= 3) {
                    String mountPath = parts[1];
                    String fsType = parts[2];
                    if (("vfat".equals(fsType) || "exfat".equals(fsType)
                            || "ntfs".equals(fsType) || "fuseblk".equals(fsType))
                            && !mountPath.contains("emulated")
                            && !mountPath.contains("/data")
                            && !mountPath.startsWith("/dev")) {
                        File dir = new File(mountPath);
                        if (dir.exists() && dir.canRead()) {
                            Log.d(TAG, "Found USB mount via /proc/mounts: " + mountPath);
                            return mountPath;
                        }
                    }
                }
            }
        } catch (IOException e) {
            Log.w(TAG, "Failed to read /proc/mounts", e);
        }

        Log.w(TAG, "No USB mount point found by any method");
        return null;
    }

    private String formatSize(long bytes) {
        if (bytes <= 0) return "Unknown";
        String[] units = {"B", "KB", "MB", "GB", "TB"};
        int idx = 0;
        double size = bytes;
        while (size >= 1024 && idx < units.length - 1) {
            size /= 1024;
            idx++;
        }
        return String.format("%.1f %s", size, units[idx]);
    }

    private List<StorageVolume> getUSBStorageVolumes() {
        StorageManager sm = (StorageManager) getContext()
                .getSystemService(Context.STORAGE_SERVICE);
        return sm.getStorageVolumes();
    }

    private long getUSBStorageSize() {
        String mount = findUSBMountPoint();
        if (mount != null) {
            File dir = new File(mount);
            return dir.getTotalSpace();
        }
        return 0;
    }

    private void cleanDirectory(File dir) {
        if (dir.exists() && dir.isDirectory()) {
            File[] files = dir.listFiles();
            if (files != null) {
                for (File file : files) {
                    if (file.isDirectory()) {
                        cleanDirectory(file);
                    }
                    file.delete();
                }
            }
            dir.delete();
        }
    }

    // ─── SAF (Storage Access Framework) helpers ───

    /**
     * Navigate to a path under a DocumentFile root, creating directories as needed.
     */
    private DocumentFile findOrCreateSAFDirectory(DocumentFile root, String path) {
        if (root == null || path == null || path.isEmpty()) return root;

        String[] parts = path.split("/");
        DocumentFile current = root;
        for (String part : parts) {
            if (part.isEmpty()) continue;
            DocumentFile child = current.findFile(part);
            if (child == null || !child.isDirectory()) {
                child = current.createDirectory(part);
            }
            if (child == null) return null;
            current = child;
        }
        return current;
    }

    /**
     * Navigate to a file path under a DocumentFile root.
     */
    private DocumentFile findSAFFile(DocumentFile root, String path) {
        if (root == null || path == null || path.isEmpty()) return null;

        String[] parts = path.split("/");
        DocumentFile current = root;
        for (int i = 0; i < parts.length; i++) {
            if (parts[i].isEmpty()) continue;
            DocumentFile child = current.findFile(parts[i]);
            if (child == null) return null;
            current = child;
        }
        return current;
    }

    /**
     * Check if SAF tree URI is available (user has selected a drive location).
     */
    private boolean hasSAFAccess() {
        return safTreeUri != null;
    }
}
