import Foundation

/// Fast mode in the chat (the composer's `/fast`) and bot settings; the host reports what the agent offers
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

    /// `/fast` in the composer turns Fast mode on or off instead of going to the agent.
    static let fastCommand = "/fast"

    /// The `/` menu offers Fast mode while `query` (what follows the `/`) could still name it.
    func offersFastCommand(_ query: String) -> Bool {
        fastModeShown && (query.isEmpty || "fast mode".localizedCaseInsensitiveContains(query))
    }

    /// A draft that is just `/fast`: sending it switches Fast mode.
    func isFastCommand(_ draft: String) -> Bool {
        fastModeShown && draft.trimmingCharacters(in: .whitespacesAndNewlines) == Self.fastCommand
    }
}
