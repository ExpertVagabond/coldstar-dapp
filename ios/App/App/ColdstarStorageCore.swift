// ColdstarStorageCore.swift
//
// The file-based replacement for Android's ColdstarUSBPlugin, iOS side.
// This is the SECURITY-CRITICAL mechanism, isolated from Capacitor so it can be
// compile-verified against the real iOS SDK on its own:
//
//   xcrun -sdk iphoneos swiftc -target arm64-apple-ios15.0 -c ColdstarStorageCore.swift
//
// It uses security-scoped bookmarks + UIDocumentPicker-granted folder URLs to
// read/write the encrypted Coldstar container on a user-selected removable (USB-C)
// drive. No formatting, no raw USB — file I/O only, which is all iOS permits and
// all the security model actually requires (ciphertext at rest, decrypt in RAM).

import Foundation

public enum ColdstarStorageError: Error, CustomStringConvertible {
    case bookmarkStale
    case bookmarkResolveFailed
    case accessDenied
    case notAColdstarVolume
    case ioFailed(String)

    public var description: String {
        switch self {
        case .bookmarkStale:        return "storage bookmark is stale; ask the user to re-select the drive"
        case .bookmarkResolveFailed:return "could not resolve the saved storage location"
        case .accessDenied:         return "could not obtain security-scoped access to the drive"
        case .notAColdstarVolume:   return "selected folder is not a Coldstar volume"
        case .ioFailed(let m):      return "file I/O failed: \(m)"
        }
    }
}

public struct ColdstarStorageCore {

    public static let formatMarker = "coldstar-usb-v1"
    public static let containerFile = "wallet/keypair.enc"
    public static let pubkeyFile = "wallet/pubkey.txt"
    public static let markerFile = ".coldstar-format"

    public init() {}

    // MARK: - Bookmarks (persist access to a user-picked drive across launches)

    /// Create persistable bookmark data for a folder URL returned by UIDocumentPicker.
    public func makeBookmark(for url: URL) throws -> Data {
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        do {
            return try url.bookmarkData(options: .minimalBookmark,
                                        includingResourceValuesForKeys: nil,
                                        relativeTo: nil)
        } catch {
            throw ColdstarStorageError.ioFailed(error.localizedDescription)
        }
    }

    /// Resolve a stored bookmark back to a usable URL.
    public func resolveBookmark(_ data: Data) throws -> URL {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data,
                                 options: [],
                                 relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else {
            throw ColdstarStorageError.bookmarkResolveFailed
        }
        if stale { throw ColdstarStorageError.bookmarkStale }
        return url
    }

    // MARK: - Scoped access helper

    /// Run `body` with security-scoped access to `folder` guaranteed to be released.
    private func withAccess<T>(_ folder: URL, _ body: (URL) throws -> T) throws -> T {
        guard folder.startAccessingSecurityScopedResource() else {
            throw ColdstarStorageError.accessDenied
        }
        defer { folder.stopAccessingSecurityScopedResource() }
        return try body(folder)
    }

    // MARK: - Provisioning (replaces Android prepareDrive/writeDirectoryStructure)
    // NOTE: no formatDrive — the drive must arrive pre-formatted FAT32/exFAT.

    /// Write the coldstar-usb-v1 layout + encrypted container to the picked folder.
    /// `encryptedContainer` and `publicKey` come from the Rust FFI (unchanged).
    public func writeContainer(bookmark: Data,
                               encryptedContainer: Data,
                               publicKey: String) throws {
        let folder = try resolveBookmark(bookmark)
        try withAccess(folder) { root in
            let fm = FileManager.default
            let wallet = root.appendingPathComponent("wallet", isDirectory: true)
            let outbox = root.appendingPathComponent("outbox", isDirectory: true)
            do {
                try fm.createDirectory(at: wallet, withIntermediateDirectories: true)
                try fm.createDirectory(at: outbox, withIntermediateDirectories: true)
                try encryptedContainer.write(to: root.appendingPathComponent(Self.containerFile),
                                             options: .atomic)
                try publicKey.data(using: .utf8)!
                    .write(to: root.appendingPathComponent(Self.pubkeyFile), options: .atomic)
                try Self.formatMarker.data(using: .utf8)!
                    .write(to: root.appendingPathComponent(Self.markerFile), options: .atomic)
            } catch {
                throw ColdstarStorageError.ioFailed(error.localizedDescription)
            }
        }
    }

    // MARK: - Read back (for in-RAM decrypt + sign)

    /// Read the encrypted container bytes from a Coldstar volume.
    public func readContainer(bookmark: Data) throws -> Data {
        let folder = try resolveBookmark(bookmark)
        return try withAccess(folder) { root in
            guard FileManager.default.fileExists(atPath:
                    root.appendingPathComponent(Self.markerFile).path) else {
                throw ColdstarStorageError.notAColdstarVolume
            }
            do {
                return try Data(contentsOf: root.appendingPathComponent(Self.containerFile))
            } catch {
                throw ColdstarStorageError.ioFailed(error.localizedDescription)
            }
        }
    }

    /// Write a signed transaction to outbox/ (offline signing flow).
    public func writeToOutbox(bookmark: Data, name: String, signedTx: Data) throws {
        let folder = try resolveBookmark(bookmark)
        try withAccess(folder) { root in
            let dest = root.appendingPathComponent("outbox/\(name)")
            do { try signedTx.write(to: dest, options: .atomic) }
            catch { throw ColdstarStorageError.ioFailed(error.localizedDescription) }
        }
    }

    /// Verify a folder is a Coldstar volume (marker present).
    public func verifyVolume(bookmark: Data) throws -> Bool {
        let folder = try resolveBookmark(bookmark)
        return try withAccess(folder) { root in
            FileManager.default.fileExists(atPath:
                root.appendingPathComponent(Self.markerFile).path)
        }
    }
}
