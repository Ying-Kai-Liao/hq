import Foundation

/// Phone/host compatibility: each side names the oldest protocol level of the other it still
/// works with (docs/reference/compatibility.md). The host sends `protocol` and `minProtocol` in
/// `hello`; this app keeps `minHostProtocol`. Mirrors `host/src/compat.rs`.
public enum VersionMismatch: Equatable, Sendable {
    /// The host no longer serves this app's protocol level.
    case updateApp
    /// The host's protocol level (or, before levels, its version) is older than this app needs.
    case updateHost(version: String)

    /// This app's protocol level, checked against the host's `minProtocol`.
    public static let protocolLevel = 1
    /// The oldest host protocol level this app works with. Raise it only when the app starts
    /// depending on something older hosts don't have (an optional feature hides its control instead).
    public static let minHostProtocol = 1
    /// A host from before protocol levels (no `protocol` in its hello) works with this app from this version.
    public static let legacyMinHost = "2.12.0"

    /// Checks this app against a host. A legacy host is held to `legacyMinHost`; its `minApp`
    /// is not checked, since every app with a protocol level is newer than any it names.
    public static func check(_ host: HostVersion, client: Int = protocolLevel, minHost: Int = minHostProtocol) -> VersionMismatch? {
        guard let level = host.protocolLevel else {
            return AppVersion.isBelow(host.version, legacyMinHost) ? .updateHost(version: host.version) : nil
        }
        if let min = host.minProtocol, client < min { return .updateApp }
        return level < minHost ? .updateHost(version: host.version) : nil
    }

    /// Whether a host has a feature that legacy hosts got in `legacyVersion`. Every host with a
    /// protocol level has all of them; an unknown host is given the benefit of the doubt.
    public static func hostHas(version: String?, protocolLevel: Int?, since legacyVersion: String) -> Bool {
        if protocolLevel != nil { return true }
        return !AppVersion.isBelow(version ?? "", legacyVersion)
    }
}

/// The fields a compatibility check needs, readable even from a `hello` whose other fields
/// this app version can't decode. `protocolLevel` is nil from a host before 0.1.0.
public struct HostVersion: Codable, Equatable, Sendable {
    public var version: String
    public var protocolLevel: Int?
    public var minProtocol: Int?

    private enum CodingKeys: String, CodingKey {
        case version, protocolLevel = "protocol", minProtocol
    }

    public init(version: String, protocolLevel: Int? = nil, minProtocol: Int? = nil) {
        self.version = version
        self.protocolLevel = protocolLevel
        self.minProtocol = minProtocol
    }
}

public enum AppVersion {
    /// This build's marketing version ("" when the bundle has none, e.g. in tests: never blocks).
    public static let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""

    /// `major.minor.patch`, ignoring a leading `v` and any pre-release or build suffix; missing
    /// parts count as 0. `nil` for anything else.
    public static func parse(_ version: String) -> [Int]? {
        var core = Substring(version.trimmingCharacters(in: .whitespaces))
        if core.first == "v" { core = core.dropFirst() }
        guard let numbers = core.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).first?
            .split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first else { return nil }
        let parts = numbers.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        var result: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber), let n = Int(part) else { return nil }
            result.append(n)
        }
        return result + Array(repeating: 0, count: 3 - result.count)
    }

    /// Whether `version` is below `minimum`; an unreadable version never is.
    public static func isBelow(_ version: String, _ minimum: String) -> Bool {
        guard let v = parse(version), let m = parse(minimum) else { return false }
        return v.lexicographicallyPrecedes(m)
    }
}
