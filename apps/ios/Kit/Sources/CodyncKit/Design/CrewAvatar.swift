import SwiftUI

/// The portraits a bot can wear: the crew with a face of their own (brand crew/<agent>.png) and
/// the spares anyone can pick (crew/spare/<name>.png), 256 px in CrewAvatars.xcassets.
/// Bundled with the app; the host never serves them.
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

    /// The image asset a bot shows, or nil when it is drawn as Codync's shape (`shape`) or is a group.
    /// `source` is the bot's `avatarSource`: `auto`, `crew:<name>`, `spare:<name>` or `shape`; a
    /// missing or unknown one is `auto`, so older hosts and newer hosts both draw something.
    public static func asset(source: String?, id: String, name: String, isGroup: Bool) -> String? {
        if isGroup { return nil }
        let source = source ?? "auto"
        if source == "shape" { return nil }
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

    static func image(_ asset: String) -> Image { Image(asset, bundle: .module) }
}
