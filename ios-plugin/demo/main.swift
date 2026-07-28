// ColdstarDemo.swift — the iOS storage demo, runnable headless on macOS.
//
// Exercises the EXACT ColdstarStorageCore.swift the iPhone app ships (same file,
// same code path) against the real Rust FFI (coldstar_generate_wallet), proving:
//
//   1. Provision  — canonical coldstar-usb-v1 layout written via writeContainer
//   2. Verify     — verifyVolume parses .coldstar/version.json (format handshake)
//   3. Round-trip — readContainer returns the Argon2id+AES-256-GCM container intact
//   4. Seeker-compat — a volume provisioned BY THE ANDROID CODE PATH (byte-for-byte
//                      WALLET_STRUCTURE from usb-flash.ts) verifies on the iOS core
//   5. Refuse-forward — a v2 volume yields supported=false and readContainer
//                      refuses with "update the app" instead of misparsing
//
// Build + run (from ios-plugin/):
//   xcrun swiftc -O ColdstarStorageCore.swift demo/ColdstarDemo.swift \
//     -import-objc-header coldstar_ffi.h \
//     -L ../backend/target/release -lcoldstar_ffi \
//     -o demo/coldstar-demo && ./demo/coldstar-demo

import Foundation

var failures = 0

func step(_ ok: Bool, _ name: String, _ detail: String = "") {
    print("\(ok ? "✅" : "❌") \(name)\(detail.isEmpty ? "" : " — \(detail)")")
    if !ok { failures += 1 }
}

func ffiJSON(_ raw: UnsafeMutablePointer<CChar>?) -> [String: Any]? {
    guard let raw else { return nil }
    defer { coldstar_free_string(raw) }
    let s = String(cString: raw)
    return (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any]
}

let core = ColdstarStorageCore()
let fm = FileManager.default
let base = fm.temporaryDirectory.appendingPathComponent("coldstar-demo-\(ProcessInfo.processInfo.processIdentifier)")
try! fm.createDirectory(at: base, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: base) }

print("Coldstar iOS storage demo — real ColdstarStorageCore + real Rust FFI\n")

// ── 1. Real wallet from the Rust core (Argon2id KDF + AES-256-GCM, keys zeroized)
let gen = ffiJSON(coldstar_generate_wallet(#"{"pin":"482913","label":"demo"}"#))
let genData = gen?["data"] as? [String: Any]
let pubkey = genData?["public_key"] as? String ?? ""
let walletObj = genData?["wallet"] as? [String: Any] ?? [:]
let walletJSON = try! JSONSerialization.data(withJSONObject: walletObj, options: [.sortedKeys])
step(gen?["success"] as? Bool == true && !pubkey.isEmpty,
     "Rust FFI coldstar_generate_wallet",
     "pubkey \(pubkey.prefix(8))…, container \(walletJSON.count)B (Argon2id + AES-256-GCM)")

// ── 2. Provision an "iOS stick" through the shipping storage core
let iosStick = base.appendingPathComponent("IOS-STICK")
try! fm.createDirectory(at: iosStick, withIntermediateDirectories: true)
let bookmark = try! core.makeBookmark(for: iosStick)
_ = try! core.writeContainer(bookmark: bookmark, encryptedContainer: walletJSON,
                             publicKey: pubkey, readme: "COLDSTAR COLD WALLET USB DRIVE (demo)")
let layoutOK = ["wallet/keypair.json", "wallet/pubkey.txt", ".coldstar/version.json",
                "inbox", "outbox", ".coldstar/backup", "README.txt"]
    .allSatisfy { fm.fileExists(atPath: iosStick.appendingPathComponent($0).path) }
step(layoutOK, "writeContainer provisions canonical coldstar-usb-v1 layout",
     "wallet/ inbox/ outbox/ .coldstar/ .coldstar/backup/ README.txt")

// ── 3. Verify + version handshake
let check = try! core.verifyVolume(bookmark: bookmark)
step(check.isColdstarVolume && check.supported && check.formatVersion == 1,
     "verifyVolume parses .coldstar/version.json", "format v\(check.formatVersion ?? -1), supported")

// ── 4. Read-back round-trip, container intact
let read = try! core.readContainer(bookmark: bookmark)
let readBack = (try? JSONSerialization.jsonObject(with: read.container)) as? [String: Any]
step(readBack?["public_key"] as? String == pubkey && readBack?["version"] as? Int == 1,
     "readContainer round-trip", "ciphertext container intact, pubkey matches")

// ── 5. Signed-tx outbox write with byte confirmation
let outbox = try! core.writeToOutbox(bookmark: bookmark, name: "demo-tx.json",
                                     signedTx: Data("{\"sig\":\"demo\"}".utf8))
step(outbox.bytesWritten == 14, "writeToOutbox confirms bytesWritten", "\(outbox.bytesWritten)B")

// ── 6. SEEKER CROSS-COMPAT: provision exactly as the Android app does
//     (WALLET_STRUCTURE from src/services/usb-flash.ts, generic writeFile path)
let seekerStick = base.appendingPathComponent("SEEKER-STICK")
for dir in ["wallet", "inbox", "outbox", ".coldstar", ".coldstar/backup"] {
    try! fm.createDirectory(at: seekerStick.appendingPathComponent(dir), withIntermediateDirectories: true)
}
let androidVersionJSON = """
{
  "version": 1,
  "appVersion": "1.0.0",
  "format": "coldstar-usb-v1",
  "createdBy": "coldstar-mobile"
}
"""
try! androidVersionJSON.write(to: seekerStick.appendingPathComponent(".coldstar/version.json"),
                              atomically: true, encoding: .utf8)
try! walletJSON.write(to: seekerStick.appendingPathComponent("wallet/keypair.json"))
try! pubkey.write(to: seekerStick.appendingPathComponent("wallet/pubkey.txt"),
                  atomically: true, encoding: .utf8)
let seekerBookmark = try! core.makeBookmark(for: seekerStick)
let seekerCheck = try! core.verifyVolume(bookmark: seekerBookmark)
let seekerRead = try? core.readContainer(bookmark: seekerBookmark)
step(seekerCheck.isColdstarVolume && seekerCheck.supported && seekerRead != nil,
     "SEEKER-provisioned volume verifies + reads on the iOS core",
     "one on-disk contract, both platforms")

// ── 7. REFUSE-FORWARD: volume from a future app version
let v2JSON = #"{"version": 2, "format": "coldstar-usb-v2", "createdBy": "coldstar-mobile"}"#
try! v2JSON.write(to: seekerStick.appendingPathComponent(".coldstar/version.json"),
                  atomically: true, encoding: .utf8)
let v2Check = try! core.verifyVolume(bookmark: seekerBookmark)
var refuseMessage = ""
do {
    _ = try core.readContainer(bookmark: seekerBookmark)
} catch let e as ColdstarStorageError {
    refuseMessage = "\(e)"
}
step(v2Check.isColdstarVolume && !v2Check.supported && refuseMessage.contains("update the app"),
     "Refuse-forward: v2 volume on a v1 app",
     "supported=false, readContainer → \"\(refuseMessage)\"")

print(failures == 0 ? "\nALL \(7 - failures)/7 CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
exit(failures == 0 ? 0 : 1)
