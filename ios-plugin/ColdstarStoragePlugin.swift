// ColdstarStoragePlugin.swift
//
// Capacitor wrapper around ColdstarStorageCore — the iOS counterpart to
// android/app/src/main/java/com/coldstar/plugins/ColdstarUSBPlugin.java.
//
// Drop into ios/App/App/plugins/ after `npx cap add ios`, and register it
// (see ColdstarStorage.m / capacitor plugin registration snippet in README).
//
// Compiles only inside the Capacitor iOS project (imports Capacitor). The
// security-critical logic lives in ColdstarStorageCore.swift + ColdstarKeychain.swift,
// which ARE standalone-compile-verified against the iOS SDK.
//
// Bookmark custody: the security-scoped bookmark is an access credential to the
// wallet container, so it never crosses the JS bridge. It lives in the Keychain
// (entitlement-scoped group, device-only); JS holds an opaque `handle`. Calls
// that still pass a legacy base64 `bookmark` are migrated into the Keychain
// once and answered with the new `handle` (iTerm2-style one-time migration).

import Foundation
import UIKit
import Capacitor

@objc(ColdstarStoragePlugin)
public class ColdstarStoragePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {

    // CAPBridgedPlugin conformance — REQUIRED for Capacitor to auto-register
    // an app-local plugin and expose these methods to JS as `ColdstarStorage`.
    public let identifier = "ColdstarStoragePlugin"
    public let jsName = "ColdstarStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickStorageLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeContainer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readContainer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeToOutbox", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetStorageLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generateWallet", returnType: CAPPluginReturnPromise),
    ]

    private let core = ColdstarStorageCore()
    private let keychain = ColdstarKeychain()
    /// All storage I/O and Rust FFI calls are serialized here: Capacitor delivers
    /// plugin calls on arbitrary threads, and neither the drive layout nor the
    /// FFI is guaranteed re-entrant.
    private let workQueue = DispatchQueue(label: "dev.coldstar.storage")

    private var pendingPick: CAPPluginCall?

    private func account(for handle: String) -> String { "bookmark.\(handle)" }

    // MARK: - Handle resolution (+ one-time legacy migration)

    private struct ResolvedHandle {
        let handle: String
        let bookmark: Data
        let migrated: Bool
    }

    /// Accepts `handle` (keychain-backed, preferred) or legacy `bookmark` base64
    /// (pre-keychain builds). Legacy bookmarks are migrated into the keychain
    /// under a fresh handle so the caller can drop the raw bookmark.
    private func resolveHandle(_ call: CAPPluginCall) -> ResolvedHandle? {
        if let handle = call.getString("handle") {
            guard let data = try? keychain.load(account: account(for: handle)) else {
                call.reject("unknown storage handle; ask the user to re-select the drive")
                return nil
            }
            return ResolvedHandle(handle: handle, bookmark: data, migrated: false)
        }
        if let b64 = call.getString("bookmark"), let data = Data(base64Encoded: b64) {
            let handle = UUID().uuidString
            do { try keychain.save(data, account: account(for: handle)) }
            catch { call.reject("\(error)"); return nil }
            return ResolvedHandle(handle: handle, bookmark: data, migrated: true)
        }
        call.reject("missing handle (or legacy bookmark)")
        return nil
    }

    /// Persist a mid-operation bookmark refresh and annotate the JS result.
    private func absorbRefresh(_ refreshed: Data?, handle: String,
                               into result: inout [String: Any]) {
        guard let fresh = refreshed else { return }
        try? keychain.save(fresh, account: account(for: handle))
        result["bookmarkRefreshed"] = true
    }

    // MARK: - pickStorageLocation()  (replaces Android listDevices + requestPermission)

    @objc func pickStorageLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // A second pick must not silently orphan the first call's promise.
            self.pendingPick?.reject("superseded by a newer picker request")
            self.pendingPick = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController,
                               didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPick else { return }
        pendingPick = nil
        guard let folder = urls.first else { call.reject("no folder selected"); return }
        workQueue.async {
            do {
                let bookmark = try self.core.makeBookmark(for: folder)
                let handle = UUID().uuidString
                try self.keychain.save(bookmark, account: self.account(for: handle))
                call.resolve([
                    "handle": handle,
                    "name": folder.lastPathComponent
                ])
            } catch {
                call.reject("\(error)")
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingPick?.reject("cancelled")
        pendingPick = nil
    }

    // MARK: - writeContainer()  (replaces prepareDrive/format/writeDirectoryStructure)

    @objc func writeContainer(_ call: CAPPluginCall) {
        guard let resolved = resolveHandle(call) else { return }
        guard let containerB64 = call.getString("encryptedContainer"),
              let container = Data(base64Encoded: containerB64),
              let pubkey = call.getString("publicKey") else {
            call.reject("missing encryptedContainer / publicKey"); return
        }
        let readme = call.getString("readme")
        workQueue.async {
            do {
                let out = try self.core.writeContainer(bookmark: resolved.bookmark,
                                                       encryptedContainer: container,
                                                       publicKey: pubkey,
                                                       readme: readme)
                var result: [String: Any] = ["success": true,
                                             "handle": resolved.handle,
                                             "bytesWritten": out.bytesWritten]
                if resolved.migrated { result["migrated"] = true }
                self.absorbRefresh(out.refreshedBookmark, handle: resolved.handle, into: &result)
                call.resolve(result)
            } catch { call.reject("\(error)") }
        }
    }

    // MARK: - readContainer()  (for in-RAM decrypt + sign)

    @objc func readContainer(_ call: CAPPluginCall) {
        guard let resolved = resolveHandle(call) else { return }
        workQueue.async {
            do {
                let out = try self.core.readContainer(bookmark: resolved.bookmark)
                var result: [String: Any] = [
                    "encryptedContainer": out.container.base64EncodedString(),
                    "handle": resolved.handle
                ]
                if resolved.migrated { result["migrated"] = true }
                self.absorbRefresh(out.refreshedBookmark, handle: resolved.handle, into: &result)
                call.resolve(result)
            } catch { call.reject("\(error)") }
        }
    }

    // MARK: - writeToOutbox()

    @objc func writeToOutbox(_ call: CAPPluginCall) {
        guard let resolved = resolveHandle(call) else { return }
        guard let name = call.getString("name"),
              let txB64 = call.getString("signedTx"), let tx = Data(base64Encoded: txB64) else {
            call.reject("missing name / signedTx"); return
        }
        workQueue.async {
            do {
                let out = try self.core.writeToOutbox(bookmark: resolved.bookmark,
                                                      name: name, signedTx: tx)
                var result: [String: Any] = ["success": true,
                                             "handle": resolved.handle,
                                             "name": name,
                                             "bytesWritten": out.bytesWritten]
                if resolved.migrated { result["migrated"] = true }
                self.absorbRefresh(out.refreshedBookmark, handle: resolved.handle, into: &result)
                call.resolve(result)
            } catch { call.reject("\(error)") }
        }
    }

    // MARK: - verifyVolume()

    @objc func verifyVolume(_ call: CAPPluginCall) {
        guard let resolved = resolveHandle(call) else { return }
        workQueue.async {
            do {
                let out = try self.core.verifyVolume(bookmark: resolved.bookmark)
                var result: [String: Any] = [
                    "isColdstarVolume": out.isColdstarVolume,
                    "supported": out.supported,
                    "handle": resolved.handle
                ]
                if let v = out.formatVersion { result["formatVersion"] = v }
                if resolved.migrated { result["migrated"] = true }
                self.absorbRefresh(out.refreshedBookmark, handle: resolved.handle, into: &result)
                call.resolve(result)
            } catch { call.reject("\(error)") }
        }
    }

    // MARK: - generateWallet()  (Rust FFI — parity with Android's JNI path)

    /// Calls coldstar_generate_wallet from the bridging header (Argon2id KDF +
    /// AES-256-GCM in secure Rust memory; plaintext key never reaches Swift/JS).
    /// Response shape matches Android's ColdstarUSBPlugin.generateWallet:
    /// { publicKey, encryptedContainer: <EncryptedWallet JSON string> }.
    @objc func generateWallet(_ call: CAPPluginCall) {
        guard let pin = call.getString("pin"), !pin.isEmpty else {
            call.reject("PIN is required"); return
        }
        let label = call.getString("label")
        workQueue.async {
            var payload: [String: Any] = ["pin": pin]
            if let label { payload["label"] = label }
            guard let inputData = try? JSONSerialization.data(withJSONObject: payload),
                  let input = String(data: inputData, encoding: .utf8) else {
                call.reject("could not encode FFI request"); return
            }
            guard let raw = coldstar_generate_wallet(input) else {
                call.reject("wallet generation failed (FFI returned null)"); return
            }
            defer { coldstar_free_string(raw) }
            let response = String(cString: raw)
            guard let json = (try? JSONSerialization.jsonObject(with: Data(response.utf8))) as? [String: Any],
                  json["success"] as? Bool == true,
                  let data = json["data"] as? [String: Any],
                  let publicKey = data["public_key"] as? String,
                  let wallet = data["wallet"],
                  let walletData = try? JSONSerialization.data(withJSONObject: wallet),
                  let walletJSON = String(data: walletData, encoding: .utf8) else {
                let message = ((try? JSONSerialization.jsonObject(with: Data(response.utf8))) as? [String: Any])?["error"] as? String
                call.reject("wallet generation failed: \(message ?? "unexpected FFI response")")
                return
            }
            call.resolve([
                "publicKey": publicKey,
                "encryptedContainer": walletJSON
            ])
        }
    }

    // MARK: - forgetStorageLocation()  (explicit revocation of a saved drive)

    @objc func forgetStorageLocation(_ call: CAPPluginCall) {
        guard let handle = call.getString("handle") else {
            call.reject("missing handle"); return
        }
        do {
            try keychain.delete(account: account(for: handle))
            call.resolve(["success": true])
        } catch { call.reject("\(error)") }
    }
}
