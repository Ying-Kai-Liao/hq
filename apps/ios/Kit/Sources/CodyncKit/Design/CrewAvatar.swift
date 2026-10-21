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
        if bot.isGroup { return nil }
        func slug(_ value: String) -> String {
            value.trimmingCharacters(in: .whitespaces).lowercased()
                .split(whereSeparator: { $0 == " " || $0 == "_" }).joined(separator: "-")
        }
        let id = slug(bot.id)
        let unprefixed = id.hasPrefix("hq-") ? String(id.dropFirst(3)) : id
        return [slug(bot.name), id, unprefixed].first { names.contains($0) }
    }

    static func image(_ name: String) -> Image { Image("crew-\(name)", bundle: .module) }
}
