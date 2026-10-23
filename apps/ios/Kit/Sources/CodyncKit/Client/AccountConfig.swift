import Foundation

/// The Clerk key and cloud URL a build runs with. `KITH_*` environment variables win over the older
/// `CODYNC_*` names, which win over the build's `AccountConfig.plist`. Empty or malformed means off.
public enum AccountConfig {
    public struct Resolved: Equatable, Sendable {
        public var clerkPublishableKey: String?
        public var cloudURL: URL?
    }

    public static func resolve(env: [String: String], cloudURL: String?, clerkPublishableKey: String?) -> Resolved {
        func pick(_ values: [String?]) -> String {
            values.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? ""
        }
        let key = pick([env["KITH_CLERK_PUBLISHABLE_KEY"], env["CODYNC_CLERK_PUBLISHABLE_KEY"], clerkPublishableKey])
        let cloud = pick([env["KITH_CLOUD_URL"], env["CODYNC_CLOUD_URL"], cloudURL])
        return Resolved(
            clerkPublishableKey: key.hasPrefix("pk_test_") || key.hasPrefix("pk_live_") ? key : nil,
            cloudURL: URL(string: cloud).flatMap { Pairing.isCloudURL($0) ? $0 : nil })
    }

    /// The OAuth return scheme when the bundle has no identifier (it always does in a real app).
    public static func fallbackScheme(environment: String?) -> String {
        environment == "dev" ? "kith-dev" : "kith"
    }
}
