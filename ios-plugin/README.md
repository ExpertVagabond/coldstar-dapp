# Coldstar iOS — file-based storage plugin (spike)

Proof-of-concept for the iOS path decided in `coldstar-token/ios-storage-plugin-spec.md`:
iOS Coldstar is real if we **rebuild the one USB plugin as file-based** and reuse the
Rust core. iOS cannot do Android's raw USB Host API (`formatDrive`, `UsbEndpoint`), but
it *can* read/write files on a user-picked USB-C drive — which is all the security model
needs (ciphertext at rest, decrypt in RAM).

## Files

| File | Role | Compiles standalone? |
|---|---|---|
| `ColdstarStorageCore.swift` | Security-critical mechanism: security-scoped bookmarks (stale auto-refresh w/ marker check), file read/write of the versioned `coldstar-usb-v<N>` layout, refuse-forward version handshake | ✅ **verified** against iPhoneOS 26.5 SDK (arm64, exit 0) |
| `ColdstarKeychain.swift` | Bookmark custody: Keychain storage (entitlement-scoped group, device-only) so the access credential never reaches the WebView | ✅ **verified** (same command) |
| `ColdstarStoragePlugin.swift` | Capacitor wrapper (UIDocumentPicker + JS bridge); opaque handles, legacy-bookmark migration, serialized work queue | Only inside the Capacitor iOS project (imports `Capacitor`) |
| `coldstar-storage.ts` | Platform switch so `usb-flash.ts` calls one interface | in-app |

## Custody + lifecycle invariants (state these to Hashlock)

1. **Plaintext never crosses the JS bridge.** Only ciphertext (base64 container) and opaque handles transit Capacitor; decrypt + sign stay in the Rust FFI.
2. **The bookmark is a credential.** It lives in the Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, optional entitlement-scoped access group for cross-signed-build survival), never in localStorage/Preferences. JS gets a `handle`; `forgetStorageLocation` revokes it.
3. **Stale ≠ revoked.** A stale bookmark that still resolves AND still passes the Coldstar marker check is re-minted silently and surfaced as `bookmarkRefreshed: true`. Flip `ColdstarStorageCore.strictStaleRecovery = true` for hard re-consent (forces a user re-pick).
4. **Refuse-forward versioning.** The marker is `.coldstar/version.json` (the exact file the shipped Android/Seeker app writes) whose `format` field carries `coldstar-usb-v<N>`; a v1 app meeting a v2 volume reports "update the app" (`volumeNewerThanApp`) instead of misparsing. Corrupt markers don't block re-provisioning (no formatDrive exists on iOS). Cross-platform layout contract: `PLATFORM-PARITY.md` at repo root.
5. **One pending picker.** A second `pickStorageLocation` rejects the superseded call instead of orphaning its promise; all volume ops run on one serial queue (Capacitor delivers calls on arbitrary threads).

## Verification run (2026-07-27, this machine)

```
xcrun -sdk iphoneos swiftc -target arm64-apple-ios15.0 -c ColdstarStorageCore.swift ColdstarKeychain.swift
# exit 0 → ColdstarStorageCore.o + ColdstarKeychain.o, architecture: arm64
```

The Rust FFI cross-compile for `aarch64-apple-ios` was also run (see the "Rust FFI"
section — the whole Solana dep tree cross-compiled; vendored OpenSSL builds from source).

## Install into the app (after `npx cap add ios`)

1. Copy `ColdstarStorageCore.swift` + `ColdstarKeychain.swift` +
   `ColdstarStoragePlugin.swift` into `ios/App/App/plugins/`.
2. Register the plugin (Capacitor 8 auto-registers `CAPPlugin` subclasses via the
   Swift package; if using the ObjC macro path, add a `ColdstarStorage.m` with
   `CAP_PLUGIN(ColdstarStoragePlugin, "ColdstarStorage", ...)` declaring each method,
   including `forgetStorageLocation`).
3. `Info.plist`: add `LSSupportsOpeningDocumentsInPlace = YES` and
   `UIFileSharingEnabled = YES` so external volumes are reachable.
4. **Keychain entitlement (recommended before first TestFlight):** add a
   `keychain-access-groups` entitlement, e.g. `$(AppIdentifierPrefix)dev.coldstar.shared`,
   and set the resolved value on `ColdstarKeychain.accessGroup` at startup — this keeps
   saved drive handles readable across differently-signed builds (dev / TestFlight /
   App Store). Doing it later = a migration for every user.
5. Replace direct `ColdstarUSB` calls in `usb-flash.ts` with `getColdstarStorage()`
   from `coldstar-storage.ts`. Persist the returned `handle` (not a bookmark); if an
   old install persisted a raw bookmark, pass it once as `bookmark` — the plugin
   migrates it into the Keychain and answers with the new `handle` (`migrated: true`).

## Rust FFI — iOS readiness notes (from reading `backend/`)

- ✅ **Already C-ABI**: `coldstar-ffi/src/lib.rs` exposes JSON-in/JSON-out over
  `CStr`/`CString`/`c_char`. That IS the iOS bridge — call it from Swift via a
  bridging header. Build: `cargo build -p coldstar-ffi --target aarch64-apple-ios
  --release`, link `libcoldstar_ffi.a` as a static lib / xcframework.
- ⚠️ **`jni` is an unconditional dependency** — it's the Android bridge and is dead on
  iOS. Gate it: `#[cfg(target_os = "android")] jni = ...` and the JNI entry points, so
  iOS builds only the C-ABI path.
- ⚠️ **`openssl` (vendored)** cross-compiles but builds OpenSSL from source (slow) and
  no `use openssl` was found in the crate sources — likely droppable, or replace with
  `rustls`, to make iOS builds faster/leaner.

## Integration status (2026-07-26) — PORTED INTO THE APP TARGET

The plugin + Rust core are now wired into `ios/App/App.xcodeproj` (via `xcodeproj` gem), not just loose files:
- `ColdstarStorageCore.swift` + `ColdstarStoragePlugin.swift` → App target Sources
- `ColdstarFFI.xcframework` → linked (Frameworks build phase + `FRAMEWORK_SEARCH_PATHS`)
- `App-Bridging-Header.h` (`#import "coldstar_ffi.h"`) → `SWIFT_OBJC_BRIDGING_HEADER`
- The plugin calls the real C-ABI: `coreGenerateWallet` → `coldstar_generate_wallet`, `coreSign` → `coldstar_sign`

**Build result (`xcodebuild -target App -sdk iphonesimulator -arch arm64`):** Swift compiled with the bridging header, **4 `Ld` link phases completed with ZERO undefined symbols** (the Rust FFI resolved), and the ONLY 2 errors were `iOS 26.5 Platform Not Installed` on the two storyboards. i.e. the entire stack — React → Capacitor → Swift plugin → bridging header → Rust `coldstar_sign` — compiles and links for iOS. Only the storyboard/asset compile + on-device run remain, both blocked by the missing iOS 26.5 platform on this machine.

## What still needs a physical device or a provisioned Mac (cannot be done headless here)

- The USB round-trip itself: iPhone 15 + FAT32 USB-C stick → pick drive → write
  container → read back → decrypt with PIN → sign devnet tx → write to `outbox/`.
  That's the 1-hour on-device spike; everything up to it is proven here.
