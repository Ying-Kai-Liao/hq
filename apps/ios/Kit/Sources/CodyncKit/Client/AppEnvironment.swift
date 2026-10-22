import Foundation

/// Read from the containing app or extension, so the shared package follows its build configuration.
public enum AppEnvironment: String, Sendable {
    case main
    case dev

    public static let current = AppEnvironment(
        rawValue: Bundle.main.object(forInfoDictionaryKey: "CodyncEnvironment") as? String ?? "main"
    ) ?? .main

    public var appGroup: String { self == .dev ? "group.com.yingkailiao.kith.dev" : "group.com.yingkailiao.kith" }
    public var urlScheme: String { self == .dev ? "kith-dev" : "kith" }
    /// The scheme links used before the Kith rename: still opened, never produced.
    public var legacyURLScheme: String { self == .dev ? "codync-dev" : "codync" }

    /// Whether `scheme` is this build's link scheme, current or legacy.
    public func accepts(scheme: String) -> Bool { scheme == urlScheme || scheme == legacyURLScheme }

    public func link(_ destination: String) -> URL {
        // All callers supply a fixed app route.
        URL(string: "\(urlScheme)://\(destination)")!
    }
}
