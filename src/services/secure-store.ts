// secure-store.ts — platform-abstracting bridge for sensitive wallet material.
//
// Native: Keystore (Android EncryptedSharedPreferences) / Keychain (iOS) via the
// SecureStore Capacitor plugin. Web: localStorage (dev only — no secure store in
// a browser). Replaces plaintext localStorage for the wallet PIN/passphrase.

import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureStorePlugin {
  set(opts: { key: string; value: string }): Promise<{ success: boolean; encrypted: boolean }>;
  get(opts: { key: string }): Promise<{ value: string | null }>;
  remove(opts: { key: string }): Promise<{ success: boolean }>;
  isEncrypted(): Promise<{ encrypted: boolean }>;
}

let plugin: SecureStorePlugin | null = null;
function native(): SecureStorePlugin | null {
  if (!Capacitor.isNativePlatform()) return null;
  if (!plugin) plugin = registerPlugin<SecureStorePlugin>('SecureStore');
  return plugin;
}

export async function secureSet(key: string, value: string): Promise<void> {
  const p = native();
  if (p) { await p.set({ key, value }); return; }
  localStorage.setItem(key, value); // web dev fallback
}

export async function secureGet(key: string): Promise<string | null> {
  const p = native();
  if (p) return (await p.get({ key })).value;
  return localStorage.getItem(key);
}

export async function secureRemove(key: string): Promise<void> {
  const p = native();
  if (p) { await p.remove({ key }); return; }
  localStorage.removeItem(key);
}

/** True when the secret is held in hardware-backed storage (Keystore/Keychain). */
export async function secureIsEncrypted(): Promise<boolean> {
  const p = native();
  if (!p) return false;
  try { return (await p.isEncrypted()).encrypted; } catch { return false; }
}
