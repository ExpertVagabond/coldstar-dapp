// ColdstarStoragePlugin.swift
//
// Capacitor wrapper around ColdstarStorageCore — the iOS counterpart to
// android/app/src/main/java/com/coldstar/plugins/ColdstarUSBPlugin.java.
//
// Drop into ios/App/App/plugins/ after `npx cap add ios`, and register it
// (see ColdstarStorage.m / capacitor plugin registration snippet in README).
//
// Compiles only inside the Capacitor iOS project (imports Capacitor). The
// security-critical logic lives in ColdstarStorageCore.swift, which IS
// standalone-compile-verified against the iOS SDK.

import Foundation
import UIKit
import Capacitor

@objc(ColdstarStoragePlugin)
public class ColdstarStoragePlugin: CAPPlugin, UIDocumentPickerDelegate {

    private let core = ColdstarStorageCore()
    private var pendingPick: CAPPluginCall?

    // MARK: - pickStorageLocation()  (replaces Android listDevices + requestPermission)

    @objc func pickStorageLocation(_ call: CAPPluginCall) {
        self.pendingPick = call
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController,
                               didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPick else { return }
        defer { pendingPick = nil }
        guard let folder = urls.first else { call.reject("no folder selected"); return }
        do {
            let bookmark = try core.makeBookmark(for: folder)
            call.resolve([
                "bookmark": bookmark.base64EncodedString(),
                "name": folder.lastPathComponent
            ])
        } catch {
            call.reject("\(error)")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingPick?.reject("cancelled")
        pendingPick = nil
    }

    // MARK: - writeContainer()  (replaces prepareDrive/format/writeDirectoryStructure)

    @objc func writeContainer(_ call: CAPPluginCall) {
        guard let b64 = call.getString("bookmark"), let bm = Data(base64Encoded: b64),
              let containerB64 = call.getString("encryptedContainer"),
              let container = Data(base64Encoded: containerB64),
              let pubkey = call.getString("publicKey") else {
            call.reject("missing bookmark / encryptedContainer / publicKey"); return
        }
        do {
            try core.writeContainer(bookmark: bm, encryptedContainer: container, publicKey: pubkey)
            call.resolve(["success": true])
        } catch { call.reject("\(error)") }
    }

    // MARK: - readContainer()  (for in-RAM decrypt + sign)

    @objc func readContainer(_ call: CAPPluginCall) {
        guard let b64 = call.getString("bookmark"), let bm = Data(base64Encoded: b64) else {
            call.reject("missing bookmark"); return
        }
        do {
            let data = try core.readContainer(bookmark: bm)
            call.resolve(["encryptedContainer": data.base64EncodedString()])
        } catch { call.reject("\(error)") }
    }

    // MARK: - writeToOutbox()

    @objc func writeToOutbox(_ call: CAPPluginCall) {
        guard let b64 = call.getString("bookmark"), let bm = Data(base64Encoded: b64),
              let name = call.getString("name"),
              let txB64 = call.getString("signedTx"), let tx = Data(base64Encoded: txB64) else {
            call.reject("missing args"); return
        }
        do { try core.writeToOutbox(bookmark: bm, name: name, signedTx: tx)
             call.resolve(["success": true]) }
        catch { call.reject("\(error)") }
    }

    // MARK: - verifyVolume()

    @objc func verifyVolume(_ call: CAPPluginCall) {
        guard let b64 = call.getString("bookmark"), let bm = Data(base64Encoded: b64) else {
            call.reject("missing bookmark"); return
        }
        do { call.resolve(["isColdstarVolume": try core.verifyVolume(bookmark: bm)]) }
        catch { call.reject("\(error)") }
    }

    // MARK: - Rust core bridge (proves ColdstarFFI.xcframework links + runs on iOS)
    // Calls the same C-ABI the Android app uses (JSON in / JSON out). This is how
    // the ported iOS app reaches coldstar_generate_wallet / coldstar_sign / etc.

    @objc func coreGenerateWallet(_ call: CAPPluginCall) {
        let reqJson = call.getString("request") ?? "{}"
        let out = reqJson.withCString { cstr -> String in
            guard let ptr = coldstar_generate_wallet(cstr) else {
                return #"{"success":false,"error":"null from core"}"#
            }
            defer { coldstar_free_string(ptr) }
            return String(cString: ptr)
        }
        call.resolve(["result": out])
    }

    @objc func coreSign(_ call: CAPPluginCall) {
        let reqJson = call.getString("request") ?? "{}"
        let out = reqJson.withCString { cstr -> String in
            guard let ptr = coldstar_sign(cstr) else {
                return #"{"success":false,"error":"null from core"}"#
            }
            defer { coldstar_free_string(ptr) }
            return String(cString: ptr)
        }
        call.resolve(["result": out])
    }
}
