/**
 * USB Flash Service — Manages the cold wallet USB flashing process
 *
 * Adapts the coldstar CLI flash process for mobile (Android USB Host API).
 * The phone connects to a USB drive via OTG and writes the cold wallet
 * structure: encrypted keypair, directory layout, and signing scripts.
 *
 * Flow mirrors https://github.com/devsyrem/coldstar flash_usb.py:
 * 1. Detect USB drive via Android USB Host API
 * 2. Request permission to access the USB mass storage device
 * 3. Format/prepare the drive (FAT32 for cross-platform compat)
 * 4. Write cold wallet directory structure
 * 5. Generate keypair, encrypt with PIN via Argon2id + AES-256-GCM
 * 6. Write encrypted wallet container to USB
 * 7. Verify installation integrity
 */

import { Capacitor } from '@capacitor/core';
import { dlog } from './debug-log';

// WebUSB API type augmentation for browsers that support it
declare global {
  interface Navigator {
    usb?: {
      getDevices(): Promise<any[]>;
      requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<any>;
    };
  }
}

// ─── Types ───

export interface USBDevice {
  deviceId: number;
  vendorId: number;
  productId: number;
  deviceName: string;
  manufacturerName: string;
  productName: string;
  serialNumber: string;
  devicePath: string;
  storageSize: number; // bytes
  formattedSize: string; // human-readable
}

export type FlashStep =
  | 'idle'
  | 'detecting'
  | 'permission'
  | 'preparing'
  | 'formatting'
  | 'writing-structure'
  | 'generating-keypair'
  | 'encrypting'
  | 'writing-wallet'
  | 'verifying'
  | 'complete'
  | 'error';

export interface FlashProgress {
  step: FlashStep;
  progress: number; // 0-100
  message: string;
  error?: string;
}

export interface ColdWalletData {
  version: number;
  publicKey: string;
  walletId: string;
  createdAt: number;
  kdfSalt: string;      // base64
  nonce: string;         // base64
  ciphertext: string;    // base64 (encrypted private key)
}

export interface FlashResult {
  success: boolean;
  publicKey?: string;
  walletId?: string;
  error?: string;
}

// ─── USB Cold Wallet Directory Structure ───
// Mirrors coldstar's USB layout:
//   wallet/
//     keypair.json    — Encrypted private key (AES-256-GCM)
//     pubkey.txt      — Public address (safe to expose)
//   inbox/            — Unsigned transactions for offline signing
//   outbox/           — Signed transactions ready to broadcast
//   .coldstar/
//     version.json    — Wallet version + metadata
//     backup/         — Automatic backup copies

// ─── Volume format version gate (refuse-forward) ───
// Shared with iOS (ColdstarStorageCore.formatVersion) — bump BOTH together and
// update PLATFORM-PARITY.md. An app meeting a NEWER volume must refuse with
// "update the app", never misparse the layout.

export const VOLUME_FORMAT_PREFIX = 'coldstar-usb-v';
export const VOLUME_FORMAT_VERSION = 1;

export type VolumeFormatCheck =
  | { ok: true; version: number }
  | { ok: false; reason: 'not-coldstar' | 'newer-than-app'; version?: number };

/** Parse .coldstar/version.json content and apply the refuse-forward gate. */
export function checkVolumeFormat(versionJson: string | null): VolumeFormatCheck {
  if (!versionJson) return { ok: false, reason: 'not-coldstar' };
  try {
    const parsed = JSON.parse(versionJson);
    const format = String(parsed.format ?? '');
    if (!format.startsWith(VOLUME_FORMAT_PREFIX)) return { ok: false, reason: 'not-coldstar' };
    const version = Number.parseInt(format.slice(VOLUME_FORMAT_PREFIX.length), 10);
    if (!Number.isFinite(version)) return { ok: false, reason: 'not-coldstar' };
    if (version > VOLUME_FORMAT_VERSION) return { ok: false, reason: 'newer-than-app', version };
    return { ok: true, version };
  } catch {
    return { ok: false, reason: 'not-coldstar' };
  }
}

// Exported so the iOS path can pass files (README.txt) through the native
// writeContainer `readme` param — one source of truth for on-drive text.
export const WALLET_STRUCTURE = {
  directories: [
    'wallet',
    'inbox',
    'outbox',
    '.coldstar',
    '.coldstar/backup',
  ],
  files: {
    'README.txt': `COLDSTAR COLD WALLET USB DRIVE
================================

This USB drive contains your Solana cold wallet.

SECURITY WARNING:
- Keep this drive OFFLINE and SECURE
- Never plug into internet-connected computers for signing
- The private key is ENCRYPTED and cannot be read without your PIN

Directory Structure:
  wallet/    — Encrypted keypair storage
  inbox/     — Place unsigned transactions here for signing
  outbox/    — Signed transactions appear here

Usage:
1. Use the Coldstar mobile app to create transactions
2. Transfer unsigned transactions to inbox/ via QR or USB
3. Sign on an air-gapped device
4. Retrieve signed transactions from outbox/
5. Broadcast using the Coldstar app

For more information: https://github.com/devsyrem/coldstar
`,
    '.coldstar/version.json': JSON.stringify({
      version: VOLUME_FORMAT_VERSION,
      appVersion: '1.0.0',
      format: `${VOLUME_FORMAT_PREFIX}${VOLUME_FORMAT_VERSION}`,
      createdBy: 'coldstar-mobile',
    }, null, 2),
  },
};

// ─── Flash Service ───

type ProgressCallback = (progress: FlashProgress) => void;

/**
 * Detect connected USB mass storage devices.
 * On Android, uses the USB Host API via our Capacitor plugin.
 * On web, uses the WebUSB API as a fallback for development.
 */
export async function detectUSBDevices(): Promise<USBDevice[]> {
  const platform = Capacitor.isNativePlatform() ? 'native' : 'web';
  dlog.info('USB', `detectUSBDevices — platform: ${platform}`);
  if (Capacitor.isNativePlatform()) {
    return detectUSBNative();
  }
  return detectUSBWeb();
}

async function detectUSBNative(): Promise<USBDevice[]> {
  try {
    dlog.debug('USB', 'detectUSBNative — calling ColdstarUSB.listDevices()');
    const pluginRef = (window as any).Capacitor?.Plugins?.ColdstarUSB;
    dlog.debug('USB', `ColdstarUSB plugin ref exists: ${!!pluginRef}`);
    const result = await pluginRef?.listDevices();
    dlog.info('USB', 'listDevices result', { hasDevices: !!result?.devices, count: result?.devices?.length ?? 0 });
    if (!result?.devices) return [];

    const mapped = result.devices.map((d: any) => ({
      deviceId: d.deviceId,
      vendorId: d.vendorId,
      productId: d.productId,
      deviceName: d.deviceName || 'USB Drive',
      manufacturerName: d.manufacturerName || 'Unknown',
      productName: d.productName || 'USB Mass Storage',
      serialNumber: d.serialNumber || '',
      devicePath: d.devicePath || '',
      storageSize: d.storageSize || 0,
      formattedSize: formatBytes(d.storageSize || 0),
    }));
    dlog.info('USB', `Detected ${mapped.length} native device(s)`, mapped.map((d: any) => d.deviceName));
    return mapped;
  } catch (err) {
    dlog.error('USB', 'detectUSBNative FAILED', { error: String(err) });
    return [];
  }
}

async function detectUSBWeb(): Promise<USBDevice[]> {
  // WebUSB fallback for development/testing
  try {
    dlog.debug('USB', `detectUSBWeb — navigator.usb exists: ${!!navigator.usb}`);
    if (!navigator.usb) return [];

    const devices = await navigator.usb.getDevices();
    dlog.info('USB', `WebUSB raw devices: ${devices.length}`);
    return devices
      .filter((d: any) => d.configuration?.interfaces.some(
        (i: any) => i.alternate.interfaceClass === 8 // Mass Storage class
      ))
      .map((d: any, i: number) => ({
        deviceId: i,
        vendorId: d.vendorId,
        productId: d.productId,
        deviceName: d.productName || 'USB Drive',
        manufacturerName: d.manufacturerName || 'Unknown',
        productName: d.productName || 'USB Mass Storage',
        serialNumber: d.serialNumber || '',
        devicePath: '',
        storageSize: 0,
        formattedSize: 'Unknown',
      }));
  } catch (err) {
    dlog.error('USB', 'detectUSBWeb FAILED', { error: String(err) });
    return [];
  }
}

/**
 * Request USB permission (Android requires explicit user consent).
 */
export async function requestUSBPermission(device: USBDevice): Promise<boolean> {
  dlog.info('USB', `requestUSBPermission — deviceId: ${device.deviceId}, name: ${device.deviceName}`);
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.requestPermission({
        deviceId: device.deviceId,
      });
      dlog.info('USB', `Permission result: granted=${result?.granted}`);
      return result?.granted === true;
    } catch (err) {
      dlog.error('USB', 'requestPermission FAILED', { error: String(err) });
      return false;
    }
  }

  // Web fallback — request device via user gesture
  try {
    await navigator.usb?.requestDevice({
      filters: [{ vendorId: device.vendorId, productId: device.productId }],
    });
    dlog.info('USB', 'WebUSB permission granted');
    return true;
  } catch (err) {
    dlog.error('USB', 'WebUSB requestDevice FAILED', { error: String(err) });
    return false;
  }
}

/**
 * Flash a USB drive with the cold wallet structure.
 *
 * This is the main entry point that mirrors coldstar's flash_usb.py process:
 * 1. Verify device is connected and permitted
 * 2. Format/prepare the drive
 * 3. Write directory structure (wallet/, inbox/, outbox/)
 * 4. Generate Ed25519 keypair
 * 5. Encrypt private key with PIN via Argon2id + AES-256-GCM
 * 6. Write encrypted container + public key to USB
 * 7. Verify written data integrity
 */
export async function flashColdWallet(
  device: USBDevice,
  pin: string,
  walletLabel: string = 'Coldstar Wallet',
  onProgress?: ProgressCallback,
): Promise<FlashResult> {
  const report = (step: FlashStep, progress: number, message: string, error?: string) => {
    onProgress?.({ step, progress, message, error });
  };

  dlog.info('Flash', `=== FLASH START === device: ${device.deviceName} (id=${device.deviceId}), label: ${walletLabel}`);
  try {
    // Step 1: Prepare disk
    report('preparing', 5, 'Preparing USB drive...');
    dlog.info('Flash', 'Step 1: prepareUSBDrive');
    const prepared = await prepareUSBDrive(device);
    dlog.info('Flash', `prepareUSBDrive result: ${prepared}`);
    if (!prepared) {
      dlog.error('Flash', 'FAILED at prepareUSBDrive');
      report('error', 0, 'Failed to prepare USB drive', 'Could not unmount or prepare the device');
      return { success: false, error: 'Failed to prepare USB drive' };
    }

    // Step 2: Format
    report('formatting', 15, 'Formatting USB drive (FAT32)...');
    dlog.info('Flash', 'Step 2: formatUSBDrive');
    const formatted = await formatUSBDrive(device);
    dlog.info('Flash', `formatUSBDrive result: ${formatted}`);
    if (!formatted) {
      dlog.error('Flash', 'FAILED at formatUSBDrive');
      report('error', 0, 'Failed to format USB drive', 'Format operation failed');
      return { success: false, error: 'Failed to format USB drive' };
    }

    // Step 3: Write directory structure
    report('writing-structure', 30, 'Creating wallet directory structure...');
    dlog.info('Flash', 'Step 3: writeDirectoryStructure');
    const structureWritten = await writeDirectoryStructure(device);
    dlog.info('Flash', `writeDirectoryStructure result: ${structureWritten}`);
    if (!structureWritten) {
      dlog.error('Flash', 'FAILED at writeDirectoryStructure');
      report('error', 0, 'Failed to create directory structure');
      return { success: false, error: 'Failed to write directory structure' };
    }

    // Step 4: Generate keypair
    report('generating-keypair', 45, 'Generating Ed25519 keypair...');
    dlog.info('Flash', 'Step 4: generateKeypairOnDevice');
    const keypairResult = await generateKeypairOnDevice(device, pin);
    dlog.info('Flash', `generateKeypairOnDevice result: ${keypairResult ? 'ok (pubkey=' + keypairResult.publicKey.slice(0, 8) + '…)' : 'null'}`);
    if (!keypairResult) {
      dlog.error('Flash', 'FAILED at generateKeypairOnDevice');
      report('error', 0, 'Failed to generate keypair');
      return { success: false, error: 'Keypair generation failed' };
    }

    // Step 5: Encrypt with PIN
    report('encrypting', 60, 'Encrypting wallet with Argon2id + AES-256-GCM...');
    dlog.info('Flash', 'Step 5: encryptAndWriteWallet');
    const walletData = await encryptAndWriteWallet(
      device,
      keypairResult.publicKey,
      keypairResult.encryptedContainer,
      walletLabel,
    );
    dlog.info('Flash', `encryptAndWriteWallet result: ${walletData ? 'ok' : 'null'}`);
    if (!walletData) {
      dlog.error('Flash', 'FAILED at encryptAndWriteWallet');
      report('error', 0, 'Failed to encrypt wallet');
      return { success: false, error: 'Wallet encryption failed' };
    }

    // Step 6: Write wallet to USB
    report('writing-wallet', 80, 'Writing encrypted wallet to USB...');
    dlog.info('Flash', 'Step 6: writeWalletToUSB');
    const written = await writeWalletToUSB(device, walletData);
    dlog.info('Flash', `writeWalletToUSB result: ${written}`);
    if (!written) {
      dlog.error('Flash', 'FAILED at writeWalletToUSB');
      report('error', 0, 'Failed to write wallet to USB');
      return { success: false, error: 'Failed to write wallet data' };
    }

    // Step 7: Verify
    report('verifying', 90, 'Verifying installation integrity...');
    dlog.info('Flash', 'Step 7: verifyUSBWallet');
    const verified = await verifyUSBWallet(device);
    dlog.info('Flash', `verifyUSBWallet result: ${verified}`);
    if (!verified) {
      dlog.error('Flash', 'FAILED at verifyUSBWallet');
      report('error', 0, 'Verification failed — wallet may be corrupted');
      return { success: false, error: 'Verification failed' };
    }

    dlog.info('Flash', '=== FLASH COMPLETE ===');
    report('complete', 100, 'Cold wallet created successfully!');

    return {
      success: true,
      publicKey: walletData.publicKey,
      walletId: walletData.walletId,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    dlog.error('Flash', `UNCAUGHT EXCEPTION: ${message}`, { stack: err instanceof Error ? err.stack : undefined });
    report('error', 0, 'Flash operation failed', message);
    return { success: false, error: message };
  }
}

// ─── Internal flash operations ───

async function prepareUSBDrive(device: USBDevice): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      dlog.debug('USB', 'prepareDrive — calling native plugin');
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.prepareDrive({
        deviceId: device.deviceId,
      });
      dlog.debug('USB', 'prepareDrive response', result);
      return result?.success === true;
    } catch (err) {
      dlog.error('USB', 'prepareDrive EXCEPTION', { error: String(err) });
      return false;
    }
  }
  // Web simulation
  await delay(500);
  return true;
}

async function formatUSBDrive(device: USBDevice): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      dlog.debug('USB', 'formatDrive — calling native plugin (FAT32)');
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.formatDrive({
        deviceId: device.deviceId,
        filesystem: 'FAT32',
        label: 'COLDSTAR',
      });
      dlog.debug('USB', 'formatDrive response', result);

      // If mount point not found, prompt user to select drive manually via SAF
      if (!result?.success && result?.needsManualSelection) {
        dlog.info('USB', 'Mount point not found, prompting user to select drive location...');
        const selectResult = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.selectDriveLocation();
        dlog.info('USB', 'selectDriveLocation result', selectResult);
        if (selectResult?.success) {
          // Retry format with SAF access now available
          const retryResult = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.formatDrive({
            deviceId: device.deviceId,
            filesystem: 'FAT32',
            label: 'COLDSTAR',
          });
          dlog.debug('USB', 'formatDrive retry response', retryResult);
          return retryResult?.success === true;
        }
        return false;
      }

      return result?.success === true;
    } catch (err) {
      dlog.error('USB', 'formatDrive EXCEPTION', { error: String(err) });
      return false;
    }
  }
  await delay(1000);
  return true;
}

async function writeDirectoryStructure(device: USBDevice): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      // Create directories
      for (const dir of WALLET_STRUCTURE.directories) {
        dlog.debug('USB', `createDirectory: ${dir}`);
        await (window as any).Capacitor?.Plugins?.ColdstarUSB?.createDirectory({
          deviceId: device.deviceId,
          path: dir,
        });
      }

      // Write files
      for (const [path, content] of Object.entries(WALLET_STRUCTURE.files)) {
        dlog.debug('USB', `writeFile: ${path} (${typeof content === 'string' ? content.length : 0} bytes)`);
        await (window as any).Capacitor?.Plugins?.ColdstarUSB?.writeFile({
          deviceId: device.deviceId,
          path,
          content,
          encoding: 'utf8',
        });
      }

      dlog.info('USB', 'Directory structure written successfully');
      return true;
    } catch (err) {
      dlog.error('USB', 'writeDirectoryStructure EXCEPTION', { error: String(err) });
      return false;
    }
  }
  await delay(500);
  return true;
}

/**
 * Generate keypair using the Rust backend (secure memory via FFI).
 * The private key never enters JavaScript — it's generated and encrypted
 * entirely in Rust-land, matching coldstar's security model.
 */
async function generateKeypairOnDevice(device: USBDevice, pin: string): Promise<{
  publicKey: string;
  encryptedContainer: string; // JSON-serialized EncryptedWallet
} | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      dlog.info('USB', 'generateWallet — calling native plugin');
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.generateWallet({
        deviceId: device.deviceId,
        pin,
      });
      dlog.info('USB', `generateWallet response — hasPubkey: ${!!result?.publicKey}, hasContainer: ${!!result?.encryptedContainer}`);
      if (result?.publicKey && result?.encryptedContainer) {
        return {
          publicKey: result.publicKey,
          encryptedContainer: result.encryptedContainer,
        };
      }
      dlog.warn('USB', 'generateWallet returned incomplete data', result);
      return null;
    } catch (err) {
      dlog.error('USB', 'generateWallet EXCEPTION', { error: String(err) });
      return null;
    }
  }

  // Web simulation — for development only.
  // In production, key generation MUST happen in Rust secure memory.
  await delay(800);
  const { Keypair } = await import('@solana/web3.js');
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    encryptedContainer: JSON.stringify({
      version: 1,
      wallet_id: `wallet-${Date.now()}`,
      public_key: keypair.publicKey.toBase58(),
      kdf_salt: Array.from(crypto.getRandomValues(new Uint8Array(32))),
      encrypted_secret_key: Array.from(crypto.getRandomValues(new Uint8Array(80))),
      created_at: Math.floor(Date.now() / 1000),
      label: 'Coldstar Wallet',
    }),
  };
}

async function encryptAndWriteWallet(
  _device: USBDevice,
  publicKey: string,
  encryptedContainer: string,
  _label: string,
): Promise<ColdWalletData | null> {
  try {
    dlog.debug('USB', 'encryptAndWriteWallet — parsing container');
    const container = JSON.parse(encryptedContainer);
    dlog.debug('USB', 'Container parsed', { version: container.version, wallet_id: container.wallet_id });
    const walletData: ColdWalletData = {
      version: container.version || 1,
      publicKey,
      walletId: container.wallet_id || `wallet-${Date.now()}`,
      createdAt: container.created_at || Math.floor(Date.now() / 1000),
      kdfSalt: arrayToBase64(container.kdf_salt),
      nonce: arrayToBase64(container.encrypted_secret_key.slice(0, 12)),
      ciphertext: arrayToBase64(container.encrypted_secret_key.slice(12)),
    };
    dlog.info('USB', 'encryptAndWriteWallet — success');
    return walletData;
  } catch (err) {
    dlog.error('USB', 'encryptAndWriteWallet EXCEPTION', { error: String(err) });
    return null;
  }
}

async function writeWalletToUSB(device: USBDevice, wallet: ColdWalletData): Promise<boolean> {
  // Write keypair.json (encrypted container — matches coldstar format)
  const keypairJson = JSON.stringify({
    version: wallet.version,
    salt: wallet.kdfSalt,
    nonce: wallet.nonce,
    ciphertext: wallet.ciphertext,
    public_key: wallet.publicKey,
  }, null, 2);

  // Write pubkey.txt (public address, safe to expose)
  const pubkeyTxt = wallet.publicKey;

  if (Capacitor.isNativePlatform()) {
    try {
      dlog.debug('USB', 'writeWalletToUSB — writing wallet/keypair.json');
      await (window as any).Capacitor?.Plugins?.ColdstarUSB?.writeFile({
        deviceId: device.deviceId,
        path: 'wallet/keypair.json',
        content: keypairJson,
        encoding: 'utf8',
      });

      dlog.debug('USB', 'writeWalletToUSB — writing wallet/pubkey.txt');
      await (window as any).Capacitor?.Plugins?.ColdstarUSB?.writeFile({
        deviceId: device.deviceId,
        path: 'wallet/pubkey.txt',
        content: pubkeyTxt,
        encoding: 'utf8',
      });

      dlog.debug('USB', 'writeWalletToUSB — writing backup copies');
      // Write backup copies (matches coldstar's .coldstar/backup/ pattern)
      await (window as any).Capacitor?.Plugins?.ColdstarUSB?.writeFile({
        deviceId: device.deviceId,
        path: '.coldstar/backup/keypair.json',
        content: keypairJson,
        encoding: 'utf8',
      });

      await (window as any).Capacitor?.Plugins?.ColdstarUSB?.writeFile({
        deviceId: device.deviceId,
        path: '.coldstar/backup/pubkey.txt',
        content: pubkeyTxt,
        encoding: 'utf8',
      });

      dlog.info('USB', 'writeWalletToUSB — all files written');
      return true;
    } catch (err) {
      dlog.error('USB', 'writeWalletToUSB EXCEPTION', { error: String(err) });
      return false;
    }
  }

  // Web simulation
  await delay(500);
  console.log('[USB Flash] Would write keypair.json:', keypairJson.slice(0, 100) + '...');
  console.log('[USB Flash] Would write pubkey.txt:', pubkeyTxt);
  return true;
}

async function verifyUSBWallet(device: USBDevice): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      dlog.debug('USB', 'verifyUSBWallet — reading back files');
      // Read back and verify the files exist and are valid JSON
      const keypairResult = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.readFile({
        deviceId: device.deviceId,
        path: 'wallet/keypair.json',
        encoding: 'utf8',
      });
      dlog.debug('USB', `verify keypair.json — hasContent: ${!!keypairResult?.content}`);

      const pubkeyResult = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.readFile({
        deviceId: device.deviceId,
        path: 'wallet/pubkey.txt',
        encoding: 'utf8',
      });

      dlog.debug('USB', `verify pubkey.txt — hasContent: ${!!pubkeyResult?.content}`);

      if (!keypairResult?.content || !pubkeyResult?.content) {
        dlog.error('USB', 'verify FAILED — missing file content', { hasKeypair: !!keypairResult?.content, hasPubkey: !!pubkeyResult?.content });
        return false;
      }

      // Verify keypair.json is valid JSON with required fields
      const keypair = JSON.parse(keypairResult.content);
      if (!keypair.version || !keypair.ciphertext || !keypair.public_key) {
        dlog.error('USB', 'verify FAILED — missing required fields in keypair.json', { hasVersion: !!keypair.version, hasCiphertext: !!keypair.ciphertext, hasPubKey: !!keypair.public_key });
        return false;
      }

      // Verify public key matches
      if (keypair.public_key !== pubkeyResult.content.trim()) {
        dlog.error('USB', 'verify FAILED — public key mismatch');
        return false;
      }

      // Refuse-forward version gate (A4): never accept a volume written by a
      // newer app than this one. Missing marker is tolerated for legacy drives.
      const versionResult = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.readFile({
        deviceId: device.deviceId,
        path: '.coldstar/version.json',
        encoding: 'utf8',
      }).catch(() => null);
      const formatCheck = checkVolumeFormat(versionResult?.content ?? null);
      if (!formatCheck.ok && formatCheck.reason === 'newer-than-app') {
        dlog.error('USB', `verify FAILED — volume format v${formatCheck.version} is newer than this app (v${VOLUME_FORMAT_VERSION}); update the app`);
        return false;
      }
      if (!formatCheck.ok) {
        dlog.warn('USB', 'verify — no readable .coldstar/version.json (legacy drive?), continuing');
      }

      dlog.info('USB', 'verifyUSBWallet — PASSED');
      return true;
    } catch (err) {
      dlog.error('USB', 'verifyUSBWallet EXCEPTION', { error: String(err) });
      return false;
    }
  }

  await delay(300);
  return true;
}

/**
 * Eject the USB drive safely after flashing.
 */
export async function ejectUSB(device: USBDevice): Promise<boolean> {
  dlog.info('USB', `ejectUSB — deviceId: ${device.deviceId}`);
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.ejectDrive({
        deviceId: device.deviceId,
      });
      dlog.info('USB', `ejectDrive result: ${result?.success}`);
      return result?.success === true;
    } catch (err) {
      dlog.error('USB', 'ejectDrive EXCEPTION', { error: String(err) });
      return false;
    }
  }
  return true;
}

/**
 * Check if a connected USB has an existing cold wallet.
 */
export async function checkExistingWallet(device: USBDevice): Promise<{
  hasWallet: boolean;
  publicKey?: string;
}> {
  dlog.info('USB', `checkExistingWallet — deviceId: ${device.deviceId}`);
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.readFile({
        deviceId: device.deviceId,
        path: 'wallet/pubkey.txt',
        encoding: 'utf8',
      });

      if (result?.content) {
        dlog.info('USB', `Existing wallet found, pubkey: ${result.content.trim().slice(0, 8)}…`);
        return { hasWallet: true, publicKey: result.content.trim() };
      }
      dlog.info('USB', 'No existing wallet on device');
      return { hasWallet: false };
    } catch (err) {
      dlog.warn('USB', 'checkExistingWallet failed', { error: String(err) });
      return { hasWallet: false };
    }
  }
  return { hasWallet: false };
}

// ─── Utilities ───

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

function arrayToBase64(arr: number[]): string {
  return btoa(String.fromCharCode(...new Uint8Array(arr)));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Public USB File I/O ───

/**
 * Read a file from the connected USB drive.
 * Returns file content as string, or null if not found.
 */
export async function readFileFromUSB(device: USBDevice, path: string): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const result = await (window as any).Capacitor?.Plugins?.ColdstarUSB?.readFile({
        deviceId: device.deviceId,
        path,
        encoding: 'utf8',
      });
      return result?.content ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Write a file to the connected USB drive.
 * Returns true on success.
 */
export async function writeFileToUSB(device: USBDevice, path: string, content: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      await (window as any).Capacitor?.Plugins?.ColdstarUSB?.writeFile({
        deviceId: device.deviceId,
        path,
        content,
        encoding: 'utf8',
      });
      return true;
    } catch {
      return false;
    }
  }
  // Web: simulated success for development
  dlog.info('USB', `[Web] writeFileToUSB simulated: ${path}`);
  return true;
}

// ─── USB Wallet Backup ───

/** Snapshot of all files on a cold wallet USB drive */
export interface USBWalletSnapshot {
  keypairJson: string;       // wallet/keypair.json
  pubkeyTxt: string;         // wallet/pubkey.txt
  versionJson: string | null; // .coldstar/version.json (optional)
}

export type BackupStep =
  | 'idle'
  | 'reading-source'
  | 'waiting-for-target'
  | 'preparing-target'
  | 'formatting'
  | 'writing-structure'
  | 'writing-wallet'
  | 'verifying'
  | 'complete'
  | 'error';

export interface BackupProgress {
  step: BackupStep;
  progress: number; // 0-100
  message: string;
  error?: string;
}

export type BackupProgressCallback = (progress: BackupProgress) => void;

/**
 * Read all critical wallet files from a USB device into memory.
 * Returns a snapshot that can later be written to a fresh drive.
 */
export async function readAllWalletFiles(device: USBDevice): Promise<USBWalletSnapshot | null> {
  dlog.info('Backup', `readAllWalletFiles — deviceId: ${device.deviceId}`);

  const keypairJson = await readFileFromUSB(device, 'wallet/keypair.json');
  if (!keypairJson) {
    dlog.error('Backup', 'No wallet/keypair.json found on source device');
    return null;
  }

  const pubkeyTxt = await readFileFromUSB(device, 'wallet/pubkey.txt');
  if (!pubkeyTxt) {
    dlog.error('Backup', 'No wallet/pubkey.txt found on source device');
    return null;
  }

  const versionJson = await readFileFromUSB(device, '.coldstar/version.json');

  // Refuse-forward version gate (A4): a drive written by a newer app must not
  // be read (or backed up into a downgraded copy) by this one.
  const formatCheck = checkVolumeFormat(versionJson);
  if (!formatCheck.ok && formatCheck.reason === 'newer-than-app') {
    dlog.error('Backup', `Volume format v${formatCheck.version} is newer than this app (v${VOLUME_FORMAT_VERSION}); update the app`);
    return null;
  }

  dlog.info('Backup', `readAllWalletFiles — success (pubkey: ${pubkeyTxt.trim().slice(0, 8)}…)`);
  return { keypairJson, pubkeyTxt: pubkeyTxt.trim(), versionJson };
}

/**
 * Write a wallet snapshot to a target USB drive.
 * Formats the drive, creates directory structure, writes all wallet files,
 * and verifies integrity.
 */
export async function writeWalletSnapshot(
  device: USBDevice,
  snapshot: USBWalletSnapshot,
  onProgress?: BackupProgressCallback,
): Promise<boolean> {
  const report = (step: BackupStep, progress: number, message: string, error?: string) => {
    onProgress?.({ step, progress, message, error });
  };

  dlog.info('Backup', `writeWalletSnapshot — deviceId: ${device.deviceId}`);

  try {
    // Step 1: Prepare
    report('preparing-target', 10, 'Preparing target USB drive...');
    const prepared = await prepareUSBDrive(device);
    if (!prepared) {
      report('error', 0, 'Failed to prepare target USB', 'Could not unmount or prepare the device');
      return false;
    }

    // Step 2: Format
    report('formatting', 25, 'Formatting target USB drive (FAT32)...');
    const formatted = await formatUSBDrive(device);
    if (!formatted) {
      report('error', 0, 'Failed to format target USB', 'Format operation failed');
      return false;
    }

    // Step 3: Write directory structure
    report('writing-structure', 40, 'Creating wallet directory structure...');
    const structureWritten = await writeDirectoryStructure(device);
    if (!structureWritten) {
      report('error', 0, 'Failed to create directory structure');
      return false;
    }

    // Step 4: Write wallet files
    report('writing-wallet', 60, 'Writing wallet files to target USB...');

    const keypairOk = await writeFileToUSB(device, 'wallet/keypair.json', snapshot.keypairJson);
    if (!keypairOk) {
      report('error', 0, 'Failed to write keypair.json');
      return false;
    }

    const pubkeyOk = await writeFileToUSB(device, 'wallet/pubkey.txt', snapshot.pubkeyTxt);
    if (!pubkeyOk) {
      report('error', 0, 'Failed to write pubkey.txt');
      return false;
    }

    // Write backup copies
    await writeFileToUSB(device, '.coldstar/backup/keypair.json', snapshot.keypairJson);
    await writeFileToUSB(device, '.coldstar/backup/pubkey.txt', snapshot.pubkeyTxt);

    if (snapshot.versionJson) {
      await writeFileToUSB(device, '.coldstar/version.json', snapshot.versionJson);
    }

    // Step 5: Verify
    report('verifying', 85, 'Verifying backup integrity...');

    const readbackKeypair = await readFileFromUSB(device, 'wallet/keypair.json');
    const readbackPubkey = await readFileFromUSB(device, 'wallet/pubkey.txt');

    if (!readbackKeypair || !readbackPubkey) {
      report('error', 0, 'Verification failed — files not readable after write');
      return false;
    }

    // Verify keypair.json is valid JSON with required fields
    const parsed = JSON.parse(readbackKeypair);
    if (!parsed.ciphertext || !parsed.public_key) {
      report('error', 0, 'Verification failed — keypair.json missing required fields');
      return false;
    }

    // Verify public key consistency
    if (parsed.public_key !== readbackPubkey.trim()) {
      report('error', 0, 'Verification failed — public key mismatch');
      return false;
    }

    dlog.info('Backup', 'writeWalletSnapshot — verified and complete');
    report('complete', 100, 'Backup completed successfully!');
    return true;

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    dlog.error('Backup', `writeWalletSnapshot EXCEPTION: ${message}`);
    report('error', 0, 'Backup failed', message);
    return false;
  }
}
