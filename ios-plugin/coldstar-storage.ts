// coldstar-storage.ts
//
// Platform-abstracting bridge so usb-flash.ts calls ONE surface. On Android it
// routes to the existing ColdstarUSB plugin (USB Host API); on iOS to the new
// file-based ColdstarStorage plugin (UIDocumentPicker + security-scoped bookmarks).
//
// Wire into usb-flash.ts by replacing direct `Capacitor.Plugins.ColdstarUSB`
// access with `getColdstarStorage()`.
//
// Custody model (iOS): the security-scoped bookmark lives in the iOS Keychain
// (entitlement-scoped group, device-only). JS only ever holds the opaque
// `handle`. If an old build persisted a raw base64 bookmark, pass it once as
// `bookmark` — the plugin migrates it into the Keychain and returns the new
// `handle` (with `migrated: true`); persist the handle and drop the bookmark.

import { Capacitor, registerPlugin } from '@capacitor/core';

/** A persisted reference to a chosen storage location (drive). */
export interface StorageLocation {
  /** Opaque keychain-backed handle (iOS). Android shim: device path/id. */
  handle: string;
  name: string;
}

/** Fields common to every volume operation result. */
export interface VolumeOpResult {
  /** Echoed back; on legacy-bookmark migration this is the NEW handle to persist. */
  handle: string;
  /** Present (true) when a legacy `bookmark` was just migrated into the Keychain. */
  migrated?: boolean;
  /**
   * Present (true) when a stale OS bookmark was auto-refreshed mid-operation
   * (drive re-plugged, etc.). Access was re-extended without a user pick —
   * surface it in the activity log; flip ColdstarStorageCore.strictStaleRecovery
   * if brand policy hardens toward explicit re-consent.
   */
  bookmarkRefreshed?: boolean;
}

/** Either the keychain handle (preferred) or a legacy raw bookmark (migrates). */
export interface VolumeRef {
  handle?: string;
  /** @deprecated pre-keychain builds only; migrated on first use. */
  bookmark?: string;
}

export interface ColdstarStorageBridge {
  /** Pick / detect where the Coldstar wallet lives. */
  pickStorageLocation(): Promise<StorageLocation>;
  /** Write the coldstar-usb-v1 layout + encrypted container. */
  writeContainer(opts: VolumeRef & {
    encryptedContainer: string; // base64, from Rust FFI (ciphertext only crosses the bridge)
    publicKey: string;
  }): Promise<VolumeOpResult & { success: boolean; bytesWritten: number }>;
  /** Read the encrypted container back for in-RAM decrypt + sign (native side). */
  readContainer(opts: VolumeRef): Promise<VolumeOpResult & { encryptedContainer: string }>;
  /** Returns bytesWritten so the UI can show explicit "signed tx landed" confirmation. */
  writeToOutbox(opts: VolumeRef & { name: string; signedTx: string })
    : Promise<VolumeOpResult & { success: boolean; name: string; bytesWritten: number }>;
  /**
   * Version handshake: `supported: false` with a formatVersion means the volume
   * was written by a NEWER app — tell the user to update, never misparse.
   */
  verifyVolume(opts: VolumeRef)
    : Promise<VolumeOpResult & { isColdstarVolume: boolean; formatVersion?: number; supported: boolean }>;
  /** Explicitly revoke a saved drive (deletes the keychain-backed bookmark). */
  forgetStorageLocation(opts: { handle: string }): Promise<{ success: boolean }>;
}

const iosStorage = registerPlugin<ColdstarStorageBridge>('ColdstarStorage');

/**
 * Returns the right storage bridge for the platform.
 * NOTE: on Android this should be adapted to wrap the existing ColdstarUSB
 * plugin's listDevices/requestPermission/prepareDrive calls behind this same
 * interface (thin shim, mapping device path/id onto `handle`), so usb-flash.ts
 * stays platform-agnostic.
 */
export function getColdstarStorage(): ColdstarStorageBridge {
  const platform = Capacitor.getPlatform();
  if (platform === 'ios') return iosStorage;
  // android / web: keep the existing ColdstarUSB path (shim to this interface)
  return registerPlugin<ColdstarStorageBridge>('ColdstarUSB');
}

/** iOS constraint the UI must surface before writing. */
export const IOS_STORAGE_NOTE =
  'On iOS the USB drive must be pre-formatted (FAT32/exFAT) and connected via ' +
  'USB-C or an adapter. You will pick the drive in the Files dialog; formatting ' +
  'and auto-detect are not available on iOS.';
