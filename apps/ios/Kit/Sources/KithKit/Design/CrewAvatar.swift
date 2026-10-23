import SwiftUI

/// The bodies a bot can wear: the crew (one per agent) and the spares anyone can pick, 512 px
/// eyeless bodies in CrewAvatars.xcassets; their eyes, tint maps and motion data are in
/// Resources/LivingBots. Bundled with the app; the host never serves them.
public enum CrewAvatar {
    public static let names: [String] = [
        "branding", "builder", "coder", "designer", "devops", "finance", "house", "image",
        "lab", "marketing", "modeler", "pemo", "personal", "resource-manager", "sound", "video",
    ]
    public static let spares: [String] = ["calendar", "chart", "cloud", "globe", "gradcap", "heart", "laptop", "magnifier"]

    /// What `auto` shows when no crew member matches the bot: the hammer bot.
    public static let fallback = "builder"

    /// The crew member a bot is, by its name or id (`house`, `Resource Manager`, `hq-coder`), or nil.
    /// Groups never are.
    static func crewName(id botId: String, name botName: String, isGroup: Bool) -> String? {
        if isGroup { return nil }
        func slug(_ value: String) -> String {
            value.trimmingCharacters(in: .whitespaces).lowercased()
                .split(whereSeparator: { $0 == " " || $0 == "_" }).joined(separator: "-")
        }
        let id = slug(botId)
        let unprefixed = id.hasPrefix("hq-") ? String(id.dropFirst(3)) : id
        return [slug(botName), id, unprefixed].first { names.contains($0) }
    }

    /// The body asset a bot shows, or nil for a group (the cube on its tile).
    /// `source` is the bot's `avatarSource`: `auto`, `crew:<name>` or `spare:<name>`; a missing or
    /// unknown one (the old `shape` too) is `auto`, so older hosts and newer hosts both draw something.
    public static func asset(source: String?, id: String, name: String, isGroup: Bool) -> String? {
        if isGroup { return nil }
        let source = source ?? "auto"
        if source.hasPrefix("crew:"), names.contains(String(source.dropFirst(5))) { return "crew-" + source.dropFirst(5) }
        if source.hasPrefix("spare:"), spares.contains(String(source.dropFirst(6))) { return "spare-" + source.dropFirst(6) }
        return "crew-" + (crewName(id: id, name: name, isGroup: false) ?? fallback)
    }

    public static func asset(for bot: Bot) -> String? {
        asset(source: bot.avatarSource, id: bot.id, name: bot.name, isGroup: bot.isGroup)
    }

    /// A saved bot's draft in the editor; a new bot (no id yet) is named after its first chats, so `auto` is the hammer bot.
    public static func asset(for draft: BotDraft, isGroup: Bool) -> String? {
        asset(source: draft.avatarSource, id: draft.id ?? "", name: draft.name, isGroup: isGroup)
    }
}
