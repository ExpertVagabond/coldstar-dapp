// SecureStorePlugin.swift — Keychain-backed key/value store for sensitive wallet
// material (the PIN/passphrase that decrypts the wallet key), replacing plaintext
// WebView localStorage. Reuses ColdstarKeychain (device-only, entitlement-scoped).
//
// Android counterpart: SecureStorePlugin.java (EncryptedSharedPreferences).
// Compiles only inside the Capacitor iOS project (imports Capacitor).

import Foundation
import Security
import Capacitor

@objc(SecureStorePlugin)
public class SecureStorePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "SecureStorePlugin"
    public let jsName = "SecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isEncrypted", returnType: CAPPluginReturnPromise),
    ]

    // Distinct keychain service from the drive bookmarks (ColdstarKeychain uses
    // dev.coldstar.storage-bookmarks); we reuse its error type only.
    private let service = "dev.coldstar.secure-kv"

    private func account(_ key: String) -> String { "kv.\(key)" }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value"),
              let data = value.data(using: .utf8) else {
            call.reject("key and value required"); return
        }
        do {
            try saveScoped(data, account: account(key))
            call.resolve(["success": true, "encrypted": true])
        } catch { call.reject("\(error)") }
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key required"); return }
        do {
            let data = try loadScoped(account: account(key))
            call.resolve(["value": String(data: data, encoding: .utf8) ?? NSNull()])
        } catch ColdstarKeychainError.notFound {
            call.resolve(["value": NSNull()])
        } catch { call.reject("\(error)") }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key required"); return }
        do { try deleteScoped(account: account(key)); call.resolve(["success": true]) }
        catch { call.reject("\(error)") }
    }

    @objc func isEncrypted(_ call: CAPPluginCall) {
        call.resolve(["encrypted": true]) // Keychain is always hardware-backed on iOS
    }

    // ── Keychain ops under this plugin's own service (Security framework directly,
    //    so we don't disturb ColdstarKeychain's bookmark service) ──

    private func query(_ acct: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: acct,
        ]
    }

    private func saveScoped(_ data: Data, account: String) throws {
        var add = query(account)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        add[kSecValueData as String] = data
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let upd = SecItemUpdate(query(account) as CFDictionary,
                                    [kSecValueData as String: data] as CFDictionary)
            guard upd == errSecSuccess else { throw ColdstarKeychainError.saveFailed(upd) }
        } else if status != errSecSuccess {
            throw ColdstarKeychainError.saveFailed(status)
        }
    }

    private func loadScoped(account: String) throws -> Data {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { throw ColdstarKeychainError.notFound }
        guard status == errSecSuccess, let data = out as? Data else {
            throw ColdstarKeychainError.loadFailed(status)
        }
        return data
    }

    private func deleteScoped(account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ColdstarKeychainError.deleteFailed(status)
        }
    }
}
