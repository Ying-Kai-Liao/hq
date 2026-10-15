import Foundation

/// Fast mode in the chat (composer) and bot settings; the host reports what the agent offers
/// (`fastModeSupport`, `fastModeIssue`): docs/features/marketplace.md, "Fast mode".
public extension Bot {
    enum FastModeState: Sendable { case on, off, refused }

    /// An agent bot whose agent offers Fast mode, or one that has it on (so it can be turned off).
    var fastModeShown: Bool {
        !isGroup && (fastMode || fastModeSupport == "offered" || fastModeSupport == "refused")
    }

    var fastModeState: FastModeState {
        guard fastMode else { return .off }
        return fastModeSupport == "refused" ? .refused : .on
    }

    /// Why it isn't in effect, when the agent turned it off itself.
    var fastModeRefusal: String? {
        guard fastModeState == .refused else { return nil }
        return "The agent turned it off: \(fastModeIssue ?? "not available"). Switch it off and on to try again."
    }
}
