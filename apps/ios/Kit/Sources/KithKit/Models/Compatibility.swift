import Foundation

/// Phone/host compatibility: each side names the oldest protocol level of the other it still
/// works with (docs/reference/compatibility.md). The host sends `protocol` and `minProtocol` in
/// `hello`; this app keeps `minHostProtocol`. Mirrors `host/src/compat.rs`.
public enum VersionMismatch: Equatable, Sendable {
    /// The host no longer serves this app's protocol level.
    case updateApp
    /// The host's protocol level is older than this app needs.
    case updateHost

    /// This app's protocol level, checked against the host's `minProtocol`.
    public static let protocolLevel = 1
    /// The oldest host protocol level this app works with. Raise it only when the app starts
    /// depending on something older hosts don't have (an optional feature hides its control instead).
    public static let minHostProtocol = 1
    /// Checks this app against a host by protocol level alone. A host without `protocol` is
    /// level 0; a missing `minProtocol` is no floor on the app.
    public static func check(_ host: HostVersion, client: Int = protocolLevel, minHost: Int = minHostProtocol) -> VersionMismatch? {
        if let min = host.minProtocol, client < min { return .updateApp }
        return (host.protocolLevel ?? 0) < minHost ? .updateHost : nil
    }
}

/// The fields a compatibility check needs, readable even from a `hello` whose other fields
/// this app version can't decode. `protocolLevel` is nil from a host before protocol levels (level 0).
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
