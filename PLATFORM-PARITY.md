# Platform Parity Map — Seeker/Android ↔ iOS

**Standing rule: every change to platform-layer code (storage, signing, custody,
volume format) MUST be mapped here across both platforms before it merges.**
A row is either implemented on both sides, or the gap is listed in the backlog
with an owner-platform. Silent drift between the shipped Seeker app and the iOS
port is a release blocker — the on-disk volume is shared hardware; a drive
provisioned on one platform must verify and work on the other.

Last full audit: 2026-07-27.

## 1. Canonical on-disk volume format (`coldstar-usb-v1`)

Single source of truth. Android writes it from `src/services/usb-flash.ts`
(`WALLET_STRUCTURE`); iOS writes it natively in `ColdstarStorageCore.writeContainer`.
**These must stay byte-compatible.**

| Item | Path | Writer (Android) | Writer (iOS) |
|---|---|---|---|
| Marker / version handshake | `.coldstar/version.json` — JSON with `format: "coldstar-usb-v<N>"` | `usb-flash.ts` WALLET_STRUCTURE.files | `ColdstarStorageCore.markerJSON()` (`createdBy: coldstar-mobile-ios`) |
| Encrypted container | `wallet/keypair.json` | JS via `writeFile` | native `writeContainer` |
| Public key | `wallet/pubkey.txt` | JS via `writeFile` | native `writeContainer` |
| Directories | `wallet/ inbox/ outbox/ .coldstar/ .coldstar/backup/` | JS via `createDirectory` | native `writeContainer` (`directories` const) |
| User-facing README | `README.txt` | JS (WALLET_STRUCTURE.files) | native, text passed from JS via `readme` param — same TS constant |

⚠️ 2026-07-27: the iOS spike originally wrote `.coldstar-format` + `wallet/keypair.enc`
(incompatible with every shipped Seeker drive). Fixed to the canonical layout above.
This is the drift class this file exists to prevent.

## 2. Plugin API surface

Since 2026-07-29 the app flow is FULLY WIRED on both platforms: `usb-flash.ts`
branches per platform (`isIOS()`), the iOS bridge lives at
`src/services/coldstar-storage.ts`, and StartupFlash shows the iOS
"Choose USB Drive…" picker path (iOS cannot auto-detect drives).

| Capability | Android `ColdstarUSB` (ColdstarUSBPlugin.java) | iOS `ColdstarStorage` (ColdstarStoragePlugin.swift) | Shared TS |
|---|---|---|---|
| Find/choose drive | `listDevices` + `requestPermission` (USB Host API), `selectDriveLocation` (SAF fallback) | `pickStorageLocation` (UIDocumentPicker — only path iOS allows); handle cached in localStorage for auto-reconnect | `detectUSBDevices()` / `selectIOSDrive()` |
| Persist drive access | SAF tree URI in Keystore-backed EncryptedSharedPreferences | **Keychain** (device-only; entitlement group ready); JS gets opaque `handle` | `StorageLocation.handle` |
| Provision layout | `formatDrive`/`createDirectory`/`writeFile` (driven by JS, step-by-step) | `writeContainer` (one atomic native call incl. `.coldstar/backup/` copies) | `flashColdWallet()` (branches per platform) |
| Read container | `readFile('wallet/keypair.json')` (generic) | `readContainer` (marker-gated, version-gated) | `readFileFromUSB()` (iOS maps wallet paths onto the bridge) |
| Signed tx out | `writeFile('outbox/…')` | `writeToOutbox` (returns `bytesWritten`) | `writeToOutbox(opts)` |
| Verify volume | none in plugin — JS checks files | `verifyVolume` (returns `formatVersion`, `supported`) | `verifyVolume(opts)` |
| Revoke saved drive | `forgetDriveLocation` | `forgetStorageLocation` | `forgetStorageLocation(opts)` |
| Wallet gen (Rust FFI) | `generateWallet` → JNI `nativeGenerateWallet` | `generateWallet` → bridging header → `coldstar_generate_wallet` (same response shape) | `generateKeypairOnDevice()` |

Registration note (iOS): the plugin conforms to `CAPBridgedPlugin`
(identifier/jsName/pluginMethods) — required for Capacitor to auto-register an
app-target plugin; without it every JS call is `undefined`.

Known iOS gap: no BiometricAuth plugin counterpart yet (Android has
BiometricAuthPlugin.java) — the unlock screen's biometric path needs an iOS
implementation (LocalAuthentication) before device testing. **Backlog B1.**

## 3. Hardening changes 2026-07-27 — parity status (ALL CLOSED same day)

| Change | iOS | Android/Seeker |
|---|---|---|
| Access credential in secure storage | ✅ Keychain (`ColdstarKeychain.swift`) | ✅ **A1** Keystore-backed `EncryptedSharedPreferences` + one-time plaintext migration (`initSecurePrefs`) |
| Superseded pending call rejected | ✅ `pickStorageLocation` | ✅ **A2** `requestPermission` resolves prior call `granted:false, superseded` |
| Stale-link recovery | ✅ auto-refresh after marker check, `bookmarkRefreshed` surfaced; `strictStaleRecovery` flag | ✅ **A3** `safRootOrNull()` verifies persisted URI permission still held; stale → explicit "re-select the drive" error (never generic) |
| Volume version handshake (refuse-forward) | ✅ native, parses `version.json.format` | ✅ **A4** shared TS `checkVolumeFormat()` in `usb-flash.ts`, gates `verifyUSBWallet` + `readAllWalletFiles` |
| Explicit drive revocation | ✅ `forgetStorageLocation` | ✅ **A5** `forgetDriveLocation` (releases persistable URI permission, clears encrypted + legacy prefs) |
| Write confirmation (`bytesWritten`) | ✅ | ✅ **A6** both `writeFile` paths |
| Serialized plugin ops | ✅ serial `DispatchQueue` | ➖ Capacitor Android runs plugin calls on its own handler thread; verify single-threaded before assuming (only open row) |
| Policy consent-versioning + escalation coalescing | n/a (agent-skill, platform-independent: `coldstar-token/agent-skill/`) | n/a |

## 3b. Demo evidence (2026-07-27/28, artifacts in `$VS/projects/coldstar-token/demos/2026-07-27/`)

- **Seeker — full flow on video** (`seeker-app-demo.mp4`): launch → auto-detected removable drive → PIN → swipe-to-flash → Rust FFI keygen + Argon2id/AES-256-GCM → "Cold Wallet Created!" → "You're All Set", on an Android 15/API-35 emulator with a virtual public volume. On-disk result verified: canonical `coldstar-usb-v1` marker + encrypted `wallet/keypair.json` + `.coldstar/backup/` copy.
- **Making the video surfaced a production bug (fixed)**: auto-mounted drives (StorageManager detection path) never passed `requestPermission` → the shipped app loops in "Scanning" forever for them. Fix + `MANAGE_EXTERNAL_STORAGE` manifest declaration on main.
- **iOS — app running on video** (`ios-app-demo.mp4`): first-ever iOS run, iOS 26.5 simulator, full UI + scanning loop. Storage core additionally proven by the 7/7 macOS harness (`ios-plugin/demo/main.swift`): generate → provision canonical layout → verify/version-handshake → read-back → outbox bytesWritten → **Seeker-provisioned volume reads on iOS core** → refuse-forward v2 ("update the app").

## 4. Shared invariants (both platforms, audit-facing)

1. Plaintext key bytes never cross the JS bridge — only ciphertext + opaque handles.
   (Known exception on both platforms: the PIN transits JS → native FFI at
   generate/sign time. Document to Hashlock; candidate for native PIN entry later.)
2. The access credential to the drive (bookmark / SAF URI) lives in
   platform-secure storage, never in WebView-readable storage. (Both ✅.)
3. Refuse-forward: an app meeting a newer `coldstar-usb-v<N>` than it knows says
   "update the app" — it never misparses. (Both ✅ — iOS native + shared TS.)
4. One approval per real ask: repeated escalations/notifications coalesce.

## 5. Process

- Changing the volume format → bump `formatVersion` in **both**
  `ColdstarStorageCore.swift` and `usb-flash.ts` in the same PR, update §1.
- Adding a plugin method → add the row in §2 with both implementations (or a
  backlog entry) before merge.
- Android plugin lives in this repo (`android/.../ColdstarUSBPlugin.java`) but the
  Seeker dApp Store build ships from `devsyrem/coldstar-dapp` — keep them synced.
