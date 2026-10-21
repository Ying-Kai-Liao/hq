import SwiftUI

/// The crew with a face of their own (brand crew/<agent>.png, 256 px in CrewAvatars.xcassets).
/// Bundled with the app; the host never serves them.
public enum CrewAvatar {
    public static let names: Set<String> = [
        "branding", "builder", "coder", "designer", "devops", "finance", "house", "image",
        "lab", "marketing", "modeler", "pemo", "personal", "resource-manager", "sound", "video",
    ]

    /// The crew member a bot is, by its name or id (`house`, `Resource Manager`, `hq-coder`), or nil.
    /// Groups never are; bots the user made keep the dotted character.
    public static func name(for bot: Bot) -> String? {
        name(id: bot.id, name: bot.name, isGroup: bot.isGroup)
    }

    /// A saved bot's draft in the editor: its portrait replaces the avatar picker, because the
    /// portrait wins over any stored shape and colour (every bot has them, chosen or not).
    public static func name(for draft: BotDraft) -> String? {
        guard let id = draft.id else { return nil }
        return name(id: id, name: draft.name, isGroup: false)
    }

    static func name(id botId: String, name botName: String, isGroup: Bool) -> String? {
        if isGroup { return nil }
        func slug(_ value: String) -> String {
            value.trimmingCharacters(in: .whitespaces).lowercased()
                .split(whereSeparator: { $0 == " " || $0 == "_" }).joined(separator: "-")
        }
        let id = slug(botId)
        let unprefixed = id.hasPrefix("hq-") ? String(id.dropFirst(3)) : id
        return [slug(botName), id, unprefixed].first { names.contains($0) }
    }

    static func image(_ name: String) -> Image { Image("crew-\(name)", bundle: .module) }
}
