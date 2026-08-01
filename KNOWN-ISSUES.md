# Known issues

## OPEN — security

- **Wallet PIN stored in PLAINTEXT in WebView localStorage (2026-08-01).**
  `storeWalletPassphrase()` (wallet.ts:186) writes the wallet PIN/passphrase to
  `localStorage` on wallet creation/registration, and `PinVerification` (the
  swap-signing gate) depends on reading it back. localStorage is readable by
  anything with app-storage access (device backup extraction, root, an XSS in
  the WebView) — and this is the PIN that decrypts the USB key container. For a
  cold-wallet product this must move to Keystore/Keychain-backed native storage
  (pattern already exists: EncryptedSharedPreferences/ColdstarKeychain) or be
  dropped in favor of prompt-always. Needs a deliberate pass because swap-flow
  UX depends on it. MUST be disclosed to the auditor; fix before audit ideally.

## RESOLVED / RECLASSIFIED

- **Backup flow bricked without biometrics — FIXED (2026-08-01).** The backup
  biometric gate's fallback checked a stored passphrase that (on non-registered
  paths) may not exist, dead-ending the flow. The gate now falls through: the
  flow's own PIN stage (verified against the wallet snapshot, wallet.ts
  `verifyPinFromKeypairJson`) is the real gate before any write.

- **Main-screen "double-render" after onboarding — NOT an app bug (2026-07-31).**
  The overlapping duplicated panels seen on the Android emulator are WebView
  surface/tile compositing corruption in the emulator itself. Evidence: with the
  screen visibly corrupted, CDP `Runtime.evaluate` DOM queries show exactly ONE
  of every element (`Total Portfolio` ×1, `Disconnected` ×1, one #root, 165
  nodes) under BOTH `-gpu auto` (gfxstream) and `-gpu swiftshader_indirect` —
  two different corruption patterns, same clean DOM. Onboarding screens render
  fine in the same sessions. Expectation: unaffected on real hardware (real GPU
  drivers); confirm during physical-device testing (queue: physical-device-tests).

- **Biometric-unavailable lockout — FIXED (2026-07-31).** PinUnlock had no
  fallback: any device without usable biometrics was permanently locked out of
  the app UI. Now falls back to wallet-PIN unlock verified by decrypting from
  the USB drive (same trust boundary as signing). Verified on emulator:
  biometrics unavailable → PIN input shown → correct PIN + drive → unlocked.
