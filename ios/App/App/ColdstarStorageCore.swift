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
//
// Volume format versioning: the marker is `.coldstar/version.json` (the same file
// the shipped Android/Seeker app writes) whose `format` field carries
// "coldstar-usb-v<N>". Readers refuse-forward — a v1 app meeting a v2 volume
// reports "update the app" instead of misparsing the layout. Bump `formatVersion`
// when the on-disk layout changes, and update BOTH platforms (PLATFORM-PARITY.md).

import Foundation

public enum ColdstarStorageError: Error, CustomStringConvertible {
    case bookmarkStale
    case bookmarkResolveFailed
    case accessDenied
    case notAColdstarVolume
    case volumeNewerThanApp(Int)
    case ioFailed(String)

    public var description: String {
        switch self {
        case .bookmarkStale:        return "storage bookmark is stale; ask the user to re-select the drive"
        case .bookmarkResolveFailed:return "could not resolve the saved storage location"
        case .accessDenied:         return "could not obtain security-scoped access to the drive"
        case .notAColdstarVolume:   return "selected folder is not a Coldstar volume"
        case .volumeNewerThanApp(let v):
            return "volume format v\(v) is newer than this app supports (v\(ColdstarStorageCore.formatVersion)); update the app"
        case .ioFailed(let m):      return "file I/O failed: \(m)"
        }
    }
}

/// Result of a volume operation. `refreshedBookmark` is non-nil when the stored
/// bookmark was stale and a fresh one was minted mid-operation; the caller MUST
/// persist it (keychain) so the next launch resolves cleanly.
public struct VolumeReadResult {
    public let container: Data
    public let refreshedBookmark: Data?
    public init(container: Data, refreshedBookmark: Data?) {
        self.container = container; self.refreshedBookmark = refreshedBookmark
    }
}

public struct VolumeWriteResult {
    public let bytesWritten: Int
    public let refreshedBookmark: Data?
    public init(bytesWritten: Int, refreshedBookmark: Data?) {
        self.bytesWritten = bytesWritten; self.refreshedBookmark = refreshedBookmark
    }
}

public struct VolumeCheckResult {
    public let isColdstarVolume: Bool
    /// Parsed from the marker file; nil when not a Coldstar volume.
    public let formatVersion: Int?
    /// False when the volume was written by a NEWER app version than this one.
    public let supported: Bool
    public let refreshedBookmark: Data?
    public init(isColdstarVolume: Bool, formatVersion: Int?, supported: Bool, refreshedBookmark: Data?) {
        self.isColdstarVolume = isColdstarVolume; self.formatVersion = formatVersion
        self.supported = supported; self.refreshedBookmark = refreshedBookmark
    }
}

public struct ColdstarStorageCore {

    // CANONICAL LAYOUT — must match the shipped Android/Seeker format exactly
    // (src/services/usb-flash.ts WALLET_STRUCTURE). A drive provisioned on either
    // platform must verify on the other. See PLATFORM-PARITY.md before changing.
    public static let formatVersion = 1
    public static let formatMarkerPrefix = "coldstar-usb-v"
    public static var formatMarker: String { "\(formatMarkerPrefix)\(formatVersion)" }
    public static let containerFile = "wallet/keypair.json"
    public static let pubkeyFile = "wallet/pubkey.txt"
    public static let markerFile = ".coldstar/version.json"
    public static let directories = ["wallet", "inbox", "outbox", ".coldstar", ".coldstar/backup"]

    /// Stale-bookmark recovery policy.
    /// false (default): a stale bookmark that still resolves AND still passes the
    ///   Coldstar marker check is refreshed silently; the refreshed bookmark is
    ///   surfaced to the caller so the UI can log/show that access was re-extended.
    /// true: stale is treated as revoked — throw and force a fresh user pick.
    /// One-line flip if brand policy hardens toward explicit re-consent.
    public static var strictStaleRecovery = false

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

    /// Resolve a stored bookmark. A stale flag does NOT mean access is revoked —
    /// the URL is still valid and the bookmark should be re-minted from it.
    private func resolveBookmark(_ data: Data) throws -> (url: URL, wasStale: Bool) {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data,
                                 options: [],
                                 relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else {
            throw ColdstarStorageError.bookmarkResolveFailed
        }
        return (url, stale)
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

    // MARK: - Marker / version handshake

    /// Parse "coldstar-usb-v<N>" from the `format` field of .coldstar/version.json
    /// (the marker Android/Seeker ships). Throws notAColdstarVolume when the
    /// marker is missing or unparseable. Call within scoped access.
    private func volumeVersion(at root: URL) throws -> Int {
        let markerURL = root.appendingPathComponent(Self.markerFile)
        guard let raw = try? Data(contentsOf: markerURL),
              let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let format = json["format"] as? String else {
            throw ColdstarStorageError.notAColdstarVolume
        }
        let trimmed = format.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(Self.formatMarkerPrefix),
              let version = Int(trimmed.dropFirst(Self.formatMarkerPrefix.count)) else {
            throw ColdstarStorageError.notAColdstarVolume
        }
        return version
    }

    /// Serialize the marker exactly as Android's WALLET_STRUCTURE does, so a
    /// drive provisioned on iOS reads identically on Seeker.
    private func markerJSON() throws -> Data {
        let payload: [String: Any] = [
            "version": Self.formatVersion,
            "appVersion": "1.0.0",
            "format": Self.formatMarker,
            "createdBy": "coldstar-mobile-ios",
        ]
        return try JSONSerialization.data(withJSONObject: payload,
                                          options: [.prettyPrinted, .sortedKeys])
    }

    /// Refuse-forward gate: a volume written by a newer app must not be misparsed.
    private func requireSupportedVersion(at root: URL) throws {
        let version = try volumeVersion(at: root)
        guard version <= Self.formatVersion else {
            throw ColdstarStorageError.volumeNewerThanApp(version)
        }
    }

    // MARK: - Stale-aware resolution

    /// Resolve a bookmark to a usable URL, applying the stale-recovery policy.
    /// `requireMarker`: refuse to refresh a stale bookmark unless the resolved
    /// folder still verifies as a Coldstar volume (don't silently re-extend
    /// access to an arbitrary folder).
    private func resolveForUse(_ bookmark: Data,
                               requireMarker: Bool) throws -> (url: URL, refreshed: Data?) {
        let (url, wasStale) = try resolveBookmark(bookmark)
        guard wasStale else { return (url, nil) }
        if Self.strictStaleRecovery { throw ColdstarStorageError.bookmarkStale }
        if requireMarker {
            let stillColdstar = try withAccess(url) { root in
                FileManager.default.fileExists(atPath:
                    root.appendingPathComponent(Self.markerFile).path)
            }
            guard stillColdstar else { throw ColdstarStorageError.bookmarkStale }
        }
        return (url, try makeBookmark(for: url))
    }

    // MARK: - Provisioning (replaces Android prepareDrive/writeDirectoryStructure)
    // NOTE: no formatDrive — the drive must arrive pre-formatted FAT32/exFAT.

    /// Write the canonical coldstar-usb-v1 layout + encrypted container to the
    /// picked folder — byte-compatible with the Android/Seeker provisioning path.
    /// `encryptedContainer` and `publicKey` come from the Rust FFI (unchanged);
    /// `readme` (optional) is supplied by the shared TS layer so the user-facing
    /// drive text has ONE source of truth (usb-flash.ts WALLET_STRUCTURE).
    /// A fresh folder is fine; an existing Coldstar volume from a NEWER app version
    /// is refused rather than clobbered.
    public func writeContainer(bookmark: Data,
                               encryptedContainer: Data,
                               publicKey: String,
                               readme: String? = nil) throws -> VolumeWriteResult {
        // requireMarker=false: first provisioning writes to a plain folder.
        let (folder, refreshed) = try resolveForUse(bookmark, requireMarker: false)
        try withAccess(folder) { root in
            let fm = FileManager.default
            // Refuse to clobber a volume from a NEWER app; an unparseable/corrupt
            // marker does NOT block re-provisioning (there is no formatDrive on iOS).
            if let existing = try? volumeVersion(at: root), existing > Self.formatVersion {
                throw ColdstarStorageError.volumeNewerThanApp(existing)
            }
            do {
                for dir in Self.directories {
                    try fm.createDirectory(at: root.appendingPathComponent(dir, isDirectory: true),
                                           withIntermediateDirectories: true)
                }
                try encryptedContainer.write(to: root.appendingPathComponent(Self.containerFile),
                                             options: .atomic)
                try publicKey.data(using: .utf8)!
                    .write(to: root.appendingPathComponent(Self.pubkeyFile), options: .atomic)
                try markerJSON()
                    .write(to: root.appendingPathComponent(Self.markerFile), options: .atomic)
                if let readme, let data = readme.data(using: .utf8) {
                    try data.write(to: root.appendingPathComponent("README.txt"), options: .atomic)
                }
            } catch let e as ColdstarStorageError {
                throw e
            } catch {
                throw ColdstarStorageError.ioFailed(error.localizedDescription)
            }
        }
        return VolumeWriteResult(bytesWritten: encryptedContainer.count,
                                 refreshedBookmark: refreshed)
    }

    // MARK: - Read back (for in-RAM decrypt + sign)

    /// Read the encrypted container bytes from a Coldstar volume.
    public func readContainer(bookmark: Data) throws -> VolumeReadResult {
        let (folder, refreshed) = try resolveForUse(bookmark, requireMarker: true)
        let data = try withAccess(folder) { root -> Data in
            try requireSupportedVersion(at: root)
            do {
                return try Data(contentsOf: root.appendingPathComponent(Self.containerFile))
            } catch {
                throw ColdstarStorageError.ioFailed(error.localizedDescription)
            }
        }
        return VolumeReadResult(container: data, refreshedBookmark: refreshed)
    }

    /// Write a signed transaction to outbox/ (offline signing flow).
    public func writeToOutbox(bookmark: Data, name: String, signedTx: Data) throws -> VolumeWriteResult {
        let (folder, refreshed) = try resolveForUse(bookmark, requireMarker: true)
        try withAccess(folder) { root in
            try requireSupportedVersion(at: root)
            let dest = root.appendingPathComponent("outbox/\(name)")
            do { try signedTx.write(to: dest, options: .atomic) }
            catch { throw ColdstarStorageError.ioFailed(error.localizedDescription) }
        }
        return VolumeWriteResult(bytesWritten: signedTx.count, refreshedBookmark: refreshed)
    }

    /// Verify a folder is a Coldstar volume and report its format version.
    public func verifyVolume(bookmark: Data) throws -> VolumeCheckResult {
        let (folder, refreshed) = try resolveForUse(bookmark, requireMarker: false)
        return try withAccess(folder) { root in
            guard let version = try? volumeVersion(at: root) else {
                return VolumeCheckResult(isColdstarVolume: false, formatVersion: nil,
                                         supported: false, refreshedBookmark: refreshed)
            }
            return VolumeCheckResult(isColdstarVolume: true, formatVersion: version,
                                     supported: version <= Self.formatVersion,
                                     refreshedBookmark: refreshed)
        }
    }
}
