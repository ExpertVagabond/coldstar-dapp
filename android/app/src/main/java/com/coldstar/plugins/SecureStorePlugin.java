package com.coldstar.plugins;

import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SecureStore — Keystore-backed key/value store for the sensitive wallet
 * material (the PIN/passphrase that decrypts the wallet key). Previously this
 * lived in plaintext WebView localStorage, readable by device-backup
 * extraction, root, or an in-WebView XSS. EncryptedSharedPreferences seals it
 * with an AES-256 key held in the Android Keystore.
 *
 * iOS counterpart: SecureStorePlugin.swift (Keychain, via ColdstarKeychain).
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {

    private static final String TAG = "SecureStore";
    private static final String PREFS = "coldstar_secure_kv";
    private SharedPreferences prefs;
    private boolean encrypted;

    @Override
    public void load() {
        try {
            MasterKey masterKey = new MasterKey.Builder(getContext())
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            prefs = EncryptedSharedPreferences.create(
                    getContext(),
                    PREFS,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
            encrypted = true;
        } catch (Exception e) {
            // Keystore unavailable (rare/broken devices): fail closed to a
            // non-encrypted store rather than crash, but report it so the JS
            // layer can warn / fall back to prompt-always.
            Log.e(TAG, "EncryptedSharedPreferences unavailable", e);
            prefs = getContext().getSharedPreferences(PREFS, 0);
            encrypted = false;
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) { call.reject("key and value required"); return; }
        prefs.edit().putString(key, value).apply();
        JSObject r = new JSObject();
        r.put("success", true);
        r.put("encrypted", encrypted);
        call.resolve(r);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) { call.reject("key required"); return; }
        JSObject r = new JSObject();
        r.put("value", prefs.getString(key, null)); // null → JS null
        call.resolve(r);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) { call.reject("key required"); return; }
        prefs.edit().remove(key).apply();
        JSObject r = new JSObject();
        r.put("success", true);
        call.resolve(r);
    }

    @PluginMethod
    public void isEncrypted(PluginCall call) {
        JSObject r = new JSObject();
        r.put("encrypted", encrypted);
        call.resolve(r);
    }
}
