import Foundation

/// The Clerk key and cloud URL a build runs with. `KITH_*` environment variables win over the build's
/// `AccountConfig.plist`. Empty or malformed means off.
public enum AccountConfig {
    public struct Resolved: Equatable, Sendable {
        public var clerkPublishableKey: String?
        public var cloudURL: URL?
    }

    public static func resolve(env: [String: String], cloudURL: String?, clerkPublishableKey: String?) -> Resolved {
        func pick(_ values: [String?]) -> String {
            values.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? ""
        }
        let key = pick([env["KITH_CLERK_PUBLISHABLE_KEY"], clerkPublishableKey])
        let cloud = pick([env["KITH_CLOUD_URL"], cloudURL])
        return Resolved(
            clerkPublishableKey: isClerkKey(key) ? key : nil,
            cloudURL: URL(string: cloud).flatMap { Pairing.isCloudURL($0) ? $0 : nil })
    }

    /// Clerk's own check, plus the one it makes later and answers with a crash: the part after the prefix is the
    /// base64 of the frontend API host, ending in `$`. A key that fails it must stay off, not reach `Clerk.configure`.
    static func isClerkKey(_ key: String) -> Bool {
        guard let prefix = ["pk_test_", "pk_live_"].first(where: key.hasPrefix) else { return false }
        var body = String(key.dropFirst(prefix.count))
        body += String(repeating: "=", count: (4 - body.count % 4) % 4)
        guard let data = Data(base64Encoded: body), let host = String(data: data, encoding: .utf8) else { return false }
        return host.count > 1 && host.hasSuffix("$")
    }

    /// The OAuth return scheme when the bundle has no identifier (it always does in a real app).
    public static func fallbackScheme(environment: String?) -> String {
        environment == "dev" ? "kith-dev" : "kith"
    }
}
