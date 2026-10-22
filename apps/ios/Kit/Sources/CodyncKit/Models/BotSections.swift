import Foundation

/// Model, effort and permission controls always stay: kith shows them read-only, so the control is the only way
/// to change them until hq becomes their one source (the next package).
///
/// Which of Codync's own cards an hq bot's page still shows. The kith sections carry the same facts,
/// read from the agent's package, so each fact shows once and kith's copy wins. A card goes only once
/// kith has the fact on screen: while the details load, fail or lack it, every card stays, and a plain
/// bot (no `hqAgent`) always shows all of them. Mirrors the desktop's `botSections`.
public struct BotSections: Equatable, Sendable {
    /// "Standing instructions": kith's About shows the agent's role.
    public var instructions = true
    /// The agent (backend) picker: kith's Model & permissions shows the harness.
    public var backendPicker = true
    /// The harness's own notes tab in Memory. For an hq bot it is Claude Code's MEMORY.md of the bot's working
    /// folder (the host's `projectMemory`), not the agent's memory: kith's "Agent memory" lists the real files.
    /// Gone for every hq bot, loaded or not.
    public var harnessMemoryTab = true

    public static let all = BotSections()

    public init() {}

    public init(hqAgent: String?, info: KithInfo?) {
        guard let hqAgent, !hqAgent.isEmpty else { return }
        harnessMemoryTab = false
        guard let info else { return }
        instructions = (info.role == nil && (info.description ?? "").isEmpty) || info.errors["role"] != nil
        backendPicker = (info.harness ?? "").isEmpty
    }
}
