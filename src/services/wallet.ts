/**
 * Wallet Service — Real Solana keypair management
 *
 * SECURITY MODEL:
 *   Encrypted private keys are stored ONLY on the USB drive (AES-256-GCM).
 *   The phone stores only metadata, public keys, and PIN hashes.
 *   Keys are loaded from USB and decrypted in memory solely for the
 *   duration of a transaction, then released for GC.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { argon2id } from 'hash-wasm';
import { detectUSBDevices, readFileFromUSB, writeFileToUSB } from './usb-flash';
import { secureSet, secureGet, secureRemove } from './secure-store';

const WALLET_STORAGE_KEY = 'coldstar_wallet_encrypted';
const WALLET_META_KEY = 'coldstar_wallet_meta';
const WALLET_PASSPHRASE_KEY = 'coldstar_wallet_passphrase';
const WALLET_REGISTRY_KEY = 'coldstar_wallet_registry';
const ACTIVE_WALLET_KEY = 'coldstar_active_wallet';
const PIN_HASH_KEY = 'coldstar_pin_hash';

/** Per-wallet localStorage key */
function perWalletKey(base: string, pubkey: string): string {
  return `${base}:${pubkey}`;
}

/** Migrate legacy storage: move encrypted keys out of localStorage (they belong on USB) */
function migrateToPerWalletStorage(): void {
  // Migrate legacy single-wallet meta → per-wallet meta
  if (!localStorage.getItem(ACTIVE_WALLET_KEY)) {
    const oldMeta = localStorage.getItem(WALLET_META_KEY);
    if (oldMeta) {
      try {
        const meta: WalletMeta = JSON.parse(oldMeta);
        const pubkey = meta.publicKey;
        localStorage.setItem(perWalletKey(WALLET_META_KEY, pubkey), oldMeta);
        const passphrase = localStorage.getItem(WALLET_PASSPHRASE_KEY);
        if (passphrase) localStorage.setItem(perWalletKey(WALLET_PASSPHRASE_KEY, pubkey), passphrase);
        const pinHash = localStorage.getItem(PIN_HASH_KEY);
        if (pinHash) localStorage.setItem(perWalletKey(PIN_HASH_KEY, pubkey), pinHash);
        localStorage.setItem(ACTIVE_WALLET_KEY, pubkey);
      } catch {}
    }
  }
  // Remove any encrypted key material that was previously stored on the phone
  localStorage.removeItem(WALLET_STORAGE_KEY);
  localStorage.removeItem(WALLET_META_KEY);
  localStorage.removeItem(WALLET_PASSPHRASE_KEY);
  localStorage.removeItem(PIN_HASH_KEY);
  // Remove per-wallet encrypted keys from localStorage (keys belong on USB)
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(WALLET_STORAGE_KEY + ':')) {
      localStorage.removeItem(k);
    }
  }
}

export interface WalletMeta {
  publicKey: string;
  createdAt: number;
  label: string;
  network: 'mainnet-beta' | 'devnet';
}

export interface WalletRegistryEntry {
  publicKey: string;
  label: string;
  createdAt: number;
  network: 'mainnet-beta' | 'devnet';
}

interface EncryptedWallet {
  iv: string;        // base64-encoded IV / nonce
  ciphertext: string; // base64-encoded encrypted secret key
  salt: string;       // base64-encoded salt
  kdf: 'pbkdf2' | 'argon2id'; // which KDF was used to derive the AES key
}

// Derive AES-GCM key from PIN using PBKDF2
async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      // TS 5.9 models Uint8Array<ArrayBufferLike>, WebCrypto wants ArrayBuffer-backed
      salt: salt as BufferSource,
      iterations: 600000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Encrypt the secret key with PIN-derived AES-GCM key
async function encryptSecretKey(secretKey: Uint8Array, pin: string): Promise<EncryptedWallet> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    secretKey as BufferSource
  );

  return {
    iv: uint8ToBase64(iv),
    ciphertext: uint8ToBase64(new Uint8Array(ciphertext)),
    salt: uint8ToBase64(salt),
    kdf: 'pbkdf2',
  };
}

// Derive AES-GCM key from PIN using Argon2id (matches Rust backend parameters)
async function deriveKeyArgon2id(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const hash = await argon2id({
    password: new TextEncoder().encode(pin),
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // 64 MiB — matches Rust ARGON2_M_COST
    hashLength: 32,
    outputType: 'binary',
  });

  return crypto.subtle.importKey(
    'raw',
    hash as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
}

// Decrypt the secret key with PIN, using the correct KDF for the wallet format
async function decryptSecretKey(wallet: EncryptedWallet, pin: string): Promise<Uint8Array> {
  const salt = base64ToUint8(wallet.salt);
  const iv = base64ToUint8(wallet.iv);
  const ciphertext = base64ToUint8(wallet.ciphertext);

  const key = wallet.kdf === 'argon2id'
    ? await deriveKeyArgon2id(pin, salt)
    : await deriveKey(pin, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );

  return new Uint8Array(plaintext);
}

function uint8ToBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Generate a random internal passphrase for wallet encryption */
function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return uint8ToBase64(bytes);
}

/**
 * Store the internal wallet passphrase (the key that decrypts the wallet) for a
 * specific wallet. Now Keystore/Keychain-backed — NEVER plaintext localStorage.
 */
export async function storeWalletPassphrase(passphrase: string, pubkey?: string): Promise<void> {
  const key = pubkey || localStorage.getItem(ACTIVE_WALLET_KEY);
  if (key) await secureSet(perWalletKey(WALLET_PASSPHRASE_KEY, key), passphrase);
}

/**
 * Retrieve the stored wallet passphrase for the active wallet from secure
 * storage. Lazily migrates any legacy plaintext-localStorage value into secure
 * storage on first read, then wipes the plaintext copy.
 */
export async function getWalletPassphrase(): Promise<string | null> {
  migrateToPerWalletStorage();
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (!activeKey) return null;
  const secureKey = perWalletKey(WALLET_PASSPHRASE_KEY, activeKey);

  const inSecure = await secureGet(secureKey);
  if (inSecure) return inSecure;

  // One-time migration: pull a plaintext value (per-wallet or legacy single-key)
  // into secure storage and remove the plaintext copies.
  const legacy = localStorage.getItem(secureKey) || localStorage.getItem(WALLET_PASSPHRASE_KEY);
  if (legacy) {
    await secureSet(secureKey, legacy);
    localStorage.removeItem(secureKey);
    localStorage.removeItem(WALLET_PASSPHRASE_KEY);
    return legacy;
  }
  return null;
}

/** Create a new wallet — encrypted key goes to USB, only metadata stored locally */
export async function createWallet(pin?: string, label: string = 'Main Wallet'): Promise<WalletMeta> {
  migrateToPerWalletStorage();
  const encryptionKey = pin && pin.length >= 6 ? pin : generatePassphrase();
  const keypair = Keypair.generate();
  const encrypted = await encryptSecretKey(keypair.secretKey, encryptionKey);
  const pubkey = keypair.publicKey.toBase58();

  // Write encrypted key to USB drive (not localStorage)
  await writeEncryptedKeyToUSB(encrypted, pubkey);

  const meta: WalletMeta = {
    publicKey: pubkey,
    createdAt: Date.now(),
    label,
    network: 'mainnet-beta',
  };

  // Store ONLY metadata locally — no private key material on phone
  localStorage.setItem(perWalletKey(WALLET_META_KEY, pubkey), JSON.stringify(meta));
  await storeWalletPassphrase(encryptionKey, pubkey);
  if (pin && pin.length >= 6) {
    const pinHash = await hashPin(pin);
    localStorage.setItem(perWalletKey(PIN_HASH_KEY, pubkey), pinHash);
  }

  localStorage.setItem(ACTIVE_WALLET_KEY, pubkey);

  addToWalletRegistry({
    publicKey: meta.publicKey,
    label: meta.label,
    createdAt: meta.createdAt,
    network: meta.network,
  });

  return meta;
}

/** Import wallet from seed phrase — encrypted key goes to USB */
export async function importWallet(secretKeyBase58: string, pin?: string, label: string = 'Imported Wallet'): Promise<WalletMeta> {
  migrateToPerWalletStorage();
  const encryptionKey = pin && pin.length >= 6 ? pin : generatePassphrase();
  const secretKey = bs58.decode(secretKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  const encrypted = await encryptSecretKey(keypair.secretKey, encryptionKey);
  const pubkey = keypair.publicKey.toBase58();

  // Write encrypted key to USB drive (not localStorage)
  await writeEncryptedKeyToUSB(encrypted, pubkey);

  const meta: WalletMeta = {
    publicKey: pubkey,
    createdAt: Date.now(),
    label,
    network: 'mainnet-beta',
  };

  // Store ONLY metadata locally
  localStorage.setItem(perWalletKey(WALLET_META_KEY, pubkey), JSON.stringify(meta));
  await storeWalletPassphrase(encryptionKey, pubkey);
  if (pin && pin.length >= 6) {
    const pinHash = await hashPin(pin);
    localStorage.setItem(perWalletKey(PIN_HASH_KEY, pubkey), pinHash);
  }

  localStorage.setItem(ACTIVE_WALLET_KEY, pubkey);

  addToWalletRegistry({
    publicKey: meta.publicKey,
    label: meta.label,
    createdAt: meta.createdAt,
    network: meta.network,
  });

  return meta;
}

/**
 * Get the decrypted Keypair — loads encrypted key from USB, decrypts in
 * memory, and returns. The caller should use the keypair briefly (sign)
 * and then let it go out of scope so GC can reclaim it.
 */
export async function getKeypair(pin: string): Promise<Keypair> {
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (!activeKey) throw new Error('No active wallet');

  // Load encrypted key from USB drive
  const { encrypted, publicKey } = await readEncryptedKeyFromUSB();

  // Verify the USB drive contains the active wallet
  if (publicKey !== activeKey) {
    throw new Error('USB drive contains a different wallet — insert the correct drive');
  }

  // Decrypt in memory for the duration of the transaction
  const secretKey = await decryptSecretKey(encrypted, pin);

  // Rust-generated wallets encrypt only the 32-byte Ed25519 seed;
  // JS-generated wallets encrypt the full 64-byte secret key.
  const keypair = secretKey.length === 32
    ? Keypair.fromSeed(secretKey)
    : Keypair.fromSecretKey(secretKey);

  // Sanity check
  if (keypair.publicKey.toBase58() !== publicKey) {
    throw new Error('Decryption produced unexpected key — wrong PIN or corrupted data');
  }

  return keypair;
}

/** Get wallet metadata (public info only) */
export function getWalletMeta(): WalletMeta | null {
  migrateToPerWalletStorage();
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (!activeKey) return null;
  const metaStr = localStorage.getItem(perWalletKey(WALLET_META_KEY, activeKey));
  if (!metaStr) return null;
  return JSON.parse(metaStr);
}

/** Check if a wallet exists (checks metadata — keys are on USB) */
export function hasWallet(): boolean {
  migrateToPerWalletStorage();
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (!activeKey) return false;
  return localStorage.getItem(perWalletKey(WALLET_META_KEY, activeKey)) !== null;
}

/** Verify PIN against stored hash */
export async function verifyPin(pin: string): Promise<boolean> {
  migrateToPerWalletStorage();
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (!activeKey) return false;
  const storedHash = localStorage.getItem(perWalletKey(PIN_HASH_KEY, activeKey));
  if (!storedHash) return false;
  const inputHash = await hashPin(pin);
  return storedHash === inputHash;
}

/** Hash PIN for verification storage */
async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`coldstar:pin:${pin}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return uint8ToBase64(new Uint8Array(hash));
}

/** Delete the active wallet metadata (keys remain on USB until drive is wiped) */
export function deleteWallet(): void {
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (activeKey) {
    localStorage.removeItem(perWalletKey(WALLET_META_KEY, activeKey));
    localStorage.removeItem(perWalletKey(WALLET_PASSPHRASE_KEY, activeKey)); // legacy plaintext
    void secureRemove(perWalletKey(WALLET_PASSPHRASE_KEY, activeKey));       // secure store
    localStorage.removeItem(perWalletKey(PIN_HASH_KEY, activeKey));
    removeFromWalletRegistry(activeKey);
  }
  localStorage.removeItem('coldstar_pin');
  localStorage.removeItem(ACTIVE_WALLET_KEY);
}

// ─── Multi-Wallet Registry ───────────────────────────────────────────────────

/** Get all registered wallets. Auto-seeds from current wallet meta if registry is empty. */
export function getWalletRegistry(): WalletRegistryEntry[] {
  const raw = localStorage.getItem(WALLET_REGISTRY_KEY);
  let registry: WalletRegistryEntry[] = raw ? JSON.parse(raw) : [];

  // Auto-seed: if registry is empty but a wallet exists, add it
  if (registry.length === 0) {
    const meta = getWalletMeta();
    if (meta) {
      registry = [{
        publicKey: meta.publicKey,
        label: meta.label,
        createdAt: meta.createdAt,
        network: meta.network,
      }];
      localStorage.setItem(WALLET_REGISTRY_KEY, JSON.stringify(registry));
    }
  }

  return registry;
}

/** Add a wallet to the registry (skips duplicates by publicKey) */
export function addToWalletRegistry(entry: WalletRegistryEntry): void {
  const registry = getWalletRegistry();
  if (registry.some(w => w.publicKey === entry.publicKey)) return;
  registry.push(entry);
  localStorage.setItem(WALLET_REGISTRY_KEY, JSON.stringify(registry));
}

/** Remove a wallet from the registry by publicKey */
export function removeFromWalletRegistry(publicKey: string): void {
  const registry = getWalletRegistry().filter(w => w.publicKey !== publicKey);
  localStorage.setItem(WALLET_REGISTRY_KEY, JSON.stringify(registry));
}

/** Switch active wallet by public key. Returns true if successful. */
export function switchWallet(publicKey: string): boolean {
  const registry = getWalletRegistry();
  if (!registry.some(w => w.publicKey === publicKey)) return false;
  localStorage.setItem(ACTIVE_WALLET_KEY, publicKey);
  return true;
}

/** Remove a wallet's local metadata (keys remain on USB) */
export function removeWallet(publicKey: string): void {
  localStorage.removeItem(perWalletKey(WALLET_META_KEY, publicKey));
  localStorage.removeItem(perWalletKey(WALLET_PASSPHRASE_KEY, publicKey)); // legacy plaintext
  void secureRemove(perWalletKey(WALLET_PASSPHRASE_KEY, publicKey));       // secure store
  localStorage.removeItem(perWalletKey(PIN_HASH_KEY, publicKey));
  removeFromWalletRegistry(publicKey);

  // If it was the active wallet, switch to another or clear
  const activeKey = localStorage.getItem(ACTIVE_WALLET_KEY);
  if (activeKey === publicKey) {
    const remaining = getWalletRegistry();
    if (remaining.length > 0) {
      localStorage.setItem(ACTIVE_WALLET_KEY, remaining[0].publicKey);
    } else {
      localStorage.removeItem(ACTIVE_WALLET_KEY);
    }
  }
}

// ─── USB Key I/O ─────────────────────────────────────────────────────────────

/**
 * Write an encrypted wallet key to the connected USB drive.
 * The file is stored at wallet/keypair.json in the coldstar format.
 */
async function writeEncryptedKeyToUSB(encrypted: EncryptedWallet, publicKey: string): Promise<void> {
  const devices = await detectUSBDevices();
  if (devices.length === 0) throw new Error('No USB drive connected — insert a drive to store the wallet key');
  const device = devices[0];

  const keypairJson = JSON.stringify({
    version: 1,
    kdf: 'pbkdf2',
    salt: encrypted.salt,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    public_key: publicKey,
  }, null, 2);

  const written = await writeFileToUSB(device, 'wallet/keypair.json', keypairJson);
  if (!written) throw new Error('Failed to write encrypted wallet to USB drive');

  await writeFileToUSB(device, 'wallet/pubkey.txt', publicKey);
}

/**
 * Read the encrypted wallet key from the connected USB drive.
 * Supports both the PBKDF2 (JS-created) and Argon2id (Rust-flashed) formats.
 */
async function readEncryptedKeyFromUSB(): Promise<{ encrypted: EncryptedWallet; publicKey: string }> {
  const devices = await detectUSBDevices();
  if (devices.length === 0) {
    throw new Error('Connect your USB wallet drive to sign transactions');
  }
  const device = devices[0];

  const content = await readFileFromUSB(device, 'wallet/keypair.json');
  if (!content) throw new Error('No wallet found on USB drive');

  const data = JSON.parse(content);

  // Detect KDF: JS-created wallets write kdf='pbkdf2' and use 'iv';
  // Rust-flashed wallets omit kdf and use 'nonce'.
  const kdf: 'pbkdf2' | 'argon2id' =
    data.kdf === 'pbkdf2' ? 'pbkdf2' : (data.nonce && !data.iv ? 'argon2id' : 'pbkdf2');

  return {
    encrypted: {
      iv: data.iv || data.nonce,
      ciphertext: data.ciphertext,
      salt: data.salt,
      kdf,
    },
    publicKey: data.public_key,
  };
}

/**
 * Register a wallet that was flashed to USB — stores only metadata on the
 * phone. The encrypted private key lives entirely on the USB drive.
 */
export async function registerUSBWallet(
  publicKey: string,
  label: string = 'Hardware Wallet',
  pin?: string,
): Promise<WalletMeta> {
  migrateToPerWalletStorage();

  const meta: WalletMeta = {
    publicKey,
    createdAt: Date.now(),
    label,
    network: 'mainnet-beta',
  };

  localStorage.setItem(perWalletKey(WALLET_META_KEY, publicKey), JSON.stringify(meta));
  localStorage.setItem(ACTIVE_WALLET_KEY, publicKey);

  if (pin) {
    await storeWalletPassphrase(pin, publicKey);
    if (pin.length >= 6) {
      const ph = await hashPin(pin);
      localStorage.setItem(perWalletKey(PIN_HASH_KEY, publicKey), ph);
    }
  }

  addToWalletRegistry({
    publicKey: meta.publicKey,
    label: meta.label,
    createdAt: meta.createdAt,
    network: meta.network,
  });

  return meta;
}

/**
 * Verify a PIN against an existing wallet on a specific USB device.
 * Reads keypair.json from the device, attempts AES-256-GCM decryption,
 * and verifies the decrypted key matches the stored public key.
 * Returns the public key on success, or throws on wrong PIN / corrupt data.
 */
export async function verifyUSBWalletPin(
  device: import('./usb-flash').USBDevice,
  pin: string,
): Promise<string> {
  const content = await readFileFromUSB(device, 'wallet/keypair.json');
  if (!content) throw new Error('No wallet found on USB drive');

  const data = JSON.parse(content);
  const kdf: 'pbkdf2' | 'argon2id' =
    data.kdf === 'pbkdf2' ? 'pbkdf2' : (data.nonce && !data.iv ? 'argon2id' : 'pbkdf2');
  const encrypted: EncryptedWallet = {
    iv: data.iv || data.nonce,
    ciphertext: data.ciphertext,
    salt: data.salt,
    kdf,
  };
  const expectedPubkey: string = data.public_key;

  const secretKey = await decryptSecretKey(encrypted, pin);
  const keypair = secretKey.length === 32
    ? Keypair.fromSeed(secretKey)
    : Keypair.fromSecretKey(secretKey);

  if (keypair.publicKey.toBase58() !== expectedPubkey) {
    throw new Error('Decryption produced unexpected key — wrong PIN or corrupted data');
  }

  return expectedPubkey;
}

/**
 * Verify a PIN against an in-memory keypair.json string (no USB read needed).
 * Used during backup flow when the source USB is already unplugged.
 * Returns the public key on success, or throws on wrong PIN / corrupt data.
 */
export async function verifyPinFromKeypairJson(
  keypairJsonContent: string,
  pin: string,
): Promise<string> {
  const data = JSON.parse(keypairJsonContent);
  const kdf: 'pbkdf2' | 'argon2id' =
    data.kdf === 'pbkdf2' ? 'pbkdf2' : (data.nonce && !data.iv ? 'argon2id' : 'pbkdf2');
  const encrypted: EncryptedWallet = {
    iv: data.iv || data.nonce,
    ciphertext: data.ciphertext,
    salt: data.salt,
    kdf,
  };
  const expectedPubkey: string = data.public_key;

  const secretKey = await decryptSecretKey(encrypted, pin);
  const keypair = secretKey.length === 32
    ? Keypair.fromSeed(secretKey)
    : Keypair.fromSecretKey(secretKey);

  if (keypair.publicKey.toBase58() !== expectedPubkey) {
    throw new Error('Decryption produced unexpected key — wrong PIN or corrupted data');
  }

  return expectedPubkey;
}

/** Get wallet public key string */
export function getPublicKey(): string | null {
  const meta = getWalletMeta();
  return meta?.publicKey ?? null;
}
