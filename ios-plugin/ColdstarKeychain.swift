// ColdstarKeychain.swift
//
// Keychain-backed storage for security-scoped drive bookmarks. The bookmark is
// an access credential to the wallet container, so it lives in the Keychain —
// never in WebView localStorage / Capacitor Preferences. JS only ever sees an
// opaque handle; the bookmark bytes stay on the native side.
//
// Standalone compile-verified alongside ColdstarStorageCore.swift:
//   xcrun -sdk iphoneos swiftc -target arm64-apple-ios15.0 -c ColdstarKeychain.swift
//
// Access group: to keep items readable across differently-signed builds
// (TestFlight / App Store / dev), add a keychain-access-groups entitlement,
// e.g. "$(AppIdentifierPrefix)dev.coldstar.shared", and set the resolved
// value (with the real team prefix) on `ColdstarKeychain.accessGroup` at
// startup. Left nil, items live in the app's default access group.

import Foundation
import Security

public enum ColdstarKeychainError: Error, CustomStringConvertible {
    case notFound
    case saveFailed(OSStatus)
    case loadFailed(OSStatus)
    case deleteFailed(OSStatus)

    public var description: String {
        switch self {
        case .notFound:               return "no keychain item for that handle"
        case .saveFailed(let s):      return "keychain save failed (OSStatus \(s))"
        case .loadFailed(let s):      return "keychain load failed (OSStatus \(s))"
        case .deleteFailed(let s):    return "keychain delete failed (OSStatus \(s))"
        }
    }
}

public struct ColdstarKeychain {

    public static let service = "dev.coldstar.storage-bookmarks"

    /// Entitlement-scoped keychain access group (see header comment). Optional.
    public static var accessGroup: String?

    public init() {}

    private func baseQuery(account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
        if let group = Self.accessGroup {
            q[kSecAttrAccessGroup as String] = group
        }
        return q
    }

    /// Insert or update. Device-only accessibility: a security-scoped bookmark is
    /// meaningless on another device, and a wallet-access credential must never
    /// ride iCloud Keychain sync or a device migration.
    public func save(_ data: Data, account: String) throws {
        var add = baseQuery(account: account)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        add[kSecValueData as String] = data
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [kSecValueData as String: data]
            let us = SecItemUpdate(baseQuery(account: account) as CFDictionary,
                                   update as CFDictionary)
            guard us == errSecSuccess else { throw ColdstarKeychainError.saveFailed(us) }
        } else if status != errSecSuccess {
            throw ColdstarKeychainError.saveFailed(status)
        }
    }

    public func load(account: String) throws -> Data {
        var q = baseQuery(account: account)
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

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ColdstarKeychainError.deleteFailed(status)
        }
    }
}
