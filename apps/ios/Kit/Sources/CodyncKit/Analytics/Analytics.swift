import Foundation

/// What the iPhone used to report. Kept so call sites compile unchanged.
public enum AnalyticsEvent: String, Sendable {
    case appOpened = "app_opened"
    case onboardingCompleted = "onboarding_completed"
    case computerPaired = "computer_paired"
    case signedIn = "signed_in"
    case signedOut = "signed_out"
    case voiceCallStarted = "voice_call_started"
}

/// Analytics are off in Kith: nothing is sent, queued or stored. The API stays so the app's call
/// sites (and a stale `analyticsEnabled` default from an older build) change nothing.
@MainActor
public final class Analytics {
    public static let shared = Analytics()

    enum Value: Encodable, Equatable, Sendable {
        case string(String), bool(Bool), int(Int), array([Value]), object([String: Value])

        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .string(let s): try c.encode(s)
            case .bool(let b): try c.encode(b)
            case .int(let i): try c.encode(i)
            case .array(let a): try c.encode(a)
            case .object(let o): try c.encode(o)
            }
        }
    }

    public static let enabledKey = "analyticsEnabled"

    public var userID: @MainActor () -> String? = { nil }

    init() {}

    public var isEnabled: Bool { false }

    /// No-op: it can't be turned back on.
    public func setEnabled(_ enabled: Bool) {}

    public func capture(_ event: AnalyticsEvent, _ properties: [String: String] = [:]) {}

    func record(_ name: String, _ extra: [String: Value]) {}

    public func becameActive() {}

    public func enteredBackground() {}

    func flush() {}
}
