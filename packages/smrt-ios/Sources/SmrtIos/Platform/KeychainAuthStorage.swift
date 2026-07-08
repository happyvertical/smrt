import Foundation
import Security
import SmrtMobile

/// Keychain-backed `AuthStorage` — the iOS counterpart of Android's
/// `KeystoreAuthStorage` (the reporter seed persisted the session in plain
/// `UserDefaults`; that is explicitly the thing to upgrade).
///
/// **Durability semantics matched to the Android impl:**
/// - Writes are **committed before return**: `SecItemAdd`/`SecItemUpdate` are
///   synchronous and persist before the (async) method resolves, so the session
///   manager can await them before handing off to the browser.
/// - `kSecAttrAccessibleAfterFirstUnlock` keeps the **pending-auth slot durable
///   across process death** during the PKCE browser round-trip.
/// - A stored item whose bytes no longer decode is deleted and treated as absent
///   — the session path degrades to re-auth rather than crashing.
///
/// Two logical slots: `session` and `pending_auth`. The Keychain encrypts at rest
/// (data-protection / Secure Enclave), so only opaque bytes touch disk.
public final class KeychainAuthStorage: NSObject, AuthStorage {
    private let service: String
    private let accessGroup: String?

    public init(service: String = "com.happyvertical.smrt.auth", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private static let sessionAccount = "session"
    private static let pendingAuthAccount = "pending_auth"

    public func readSession() async throws -> String? { read(account: Self.sessionAccount) }
    public func writeSession(value: String) async throws { try write(account: Self.sessionAccount, value: value) }
    public func clearSession() async throws { try delete(account: Self.sessionAccount) }

    public func readPendingAuth() async throws -> String? { read(account: Self.pendingAuthAccount) }
    public func writePendingAuth(value: String) async throws { try write(account: Self.pendingAuthAccount, value: value) }
    public func clearPendingAuth() async throws { try delete(account: Self.pendingAuthAccount) }

    // MARK: - Keychain (synchronous → committed before the async method resolves)

    private func read(account: String) -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        guard let value = String(data: data, encoding: .utf8) else {
            // Undecodable (e.g. key lost after a device restore) — remove and
            // treat as absent so the session degrades to re-auth.
            try? delete(account: account)
            return nil
        }
        return value
    }

    private func write(account: String, value: String) throws {
        let data = Data(value.utf8)
        let query = baseQuery(account: account)

        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return }

        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
            return
        }
        throw KeychainError.status(updateStatus)
    }

    private func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    enum KeychainError: Error, Equatable {
        case status(OSStatus)
    }
}
