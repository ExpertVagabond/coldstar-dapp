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

| Capability | Android `ColdstarUSB` (ColdstarUSBPlugin.java) | iOS `ColdstarStorage` (ColdstarStoragePlugin.swift) | Shared TS |
|---|---|---|---|
| Find/choose drive | `listDevices` + `requestPermission` (USB Host API), `selectDriveLocation` (SAF fallback) | `pickStorageLocation` (UIDocumentPicker — only path iOS allows) | `getColdstarStorage().pickStorageLocation()` |
| Persist drive access | SAF tree URI in **plaintext SharedPreferences** (`saf_tree_uri`) | **Keychain** (device-only; entitlement group ready); JS gets opaque `handle` | `StorageLocation.handle` |
| Provision layout | `formatDrive`/`createDirectory`/`writeFile` (driven by JS, step-by-step) | `writeContainer` (one atomic native call) | `writeContainer(opts)` |
| Read container | `readFile('wallet/keypair.json')` (generic) | `readContainer` (marker-gated, version-gated) | `readContainer(opts)` |
| Signed tx out | `writeFile('outbox/…')` | `writeToOutbox` (returns `bytesWritten`) | `writeToOutbox(opts)` |
| Verify volume | none in plugin — JS checks files | `verifyVolume` (returns `formatVersion`, `supported`) | `verifyVolume(opts)` |
| Revoke saved drive | **none** | `forgetStorageLocation` | `forgetStorageLocation(opts)` |
| Wallet gen (Rust FFI) | `generateWallet` → JNI `nativeGenerateWallet` | app target → bridging header → `coldstar_generate_wallet` | via plugin |

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

## 3b. Demo evidence (2026-07-27, artifacts in `$VS/projects/coldstar-token/demos/2026-07-27/`)

- **Seeker**: `assembleDebug` BUILD SUCCESSFUL (33M APK, all A-fixes compiled) → installed on Android 15/API-35 emulator → app foreground, hardened `ColdstarUSBPlugin` scan loop live in logcat. `seeker-demo-transcript.txt` + `seeker-emulator-hardened-build.png`.
- **iOS**: `ios-plugin/demo/main.swift` runs the SHIPPING `ColdstarStorageCore.swift` + real Rust FFI on macOS — 7/7 checks: generate (Argon2id+AES-GCM) → provision canonical layout → verify/version-handshake → read-back → outbox bytesWritten → **Seeker-provisioned volume reads on iOS core** → refuse-forward v2 ("update the app"). `ios-demo-transcript.txt`. App target builds + links clean.

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
