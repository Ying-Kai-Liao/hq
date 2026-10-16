import CodyncKit

/// A command in the composer's `/` list.
struct SlashCommand: Identifiable, Equatable {
    enum Action: Hashable { case fast, newSession, skill(String) }

    /// What follows the `/`.
    let name: String
    let icon: String
    let title: String
    let detail: String
    let warning: Bool
    let action: Action

    var id: Action { action }
}

/// The composer's `/` commands, listed while the draft is just `/partial`: Fast mode and New
/// session run here through host methods (`updateBot`, `newSession`); a skill fills in
/// `/<id> `, and the host turns that message into "read this skill first"
/// (`host/src/market/skills.rs` `expand_command`). docs/features/marketplace.md, "Commands".
enum SlashCommands {
    /// The first host that understands `/skill` messages; older ones get the text as typed.
    static let minSkillsHost = "2.14.1"

    /// The command name being typed after a leading `/`, before any space.
    static func query(_ draft: String) -> String? {
        guard draft.hasPrefix("/"), !draft.contains(where: \.isWhitespace) else { return nil }
        return String(draft.dropFirst())
    }

    /// Built-in commands, then the bot's skills, whose name or title holds `query` (none in a group).
    static func list(for bot: Bot?, query: String, skills: [InstalledSkill]) -> [SlashCommand] {
        guard let bot, !bot.isGroup else { return [] }
        let own = skills.filter { bot.skills.contains($0.id) }.map {
            SlashCommand(name: $0.id, icon: "book.pages", title: $0.name, detail: $0.description, warning: false, action: .skill($0.id))
        }
        return (builtIn(bot) + own).filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.title.localizedCaseInsensitiveContains(query)
        }
    }

    /// A draft that is just a built-in command (`/fast`, `/new`): sending it runs the command.
    static func builtIn(for bot: Bot?, draft: String) -> SlashCommand? {
        guard let bot, let name = query(draft.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return builtIn(bot).first { $0.name == name }
    }

    private static func builtIn(_ bot: Bot) -> [SlashCommand] {
        guard !bot.isGroup else { return [] }
        var commands: [SlashCommand] = []
        if bot.fastModeShown {
            commands.append(SlashCommand(name: "fast", icon: "bolt", title: "Fast mode", detail: bot.fastModeDetail,
                                         warning: bot.fastModeState == .refused, action: .fast))
        }
        commands.append(SlashCommand(name: "new", icon: "arrow.counterclockwise", title: "New session",
                                     detail: "Start over with a fresh context; the transcript stays", warning: false, action: .newSession))
        return commands
    }
}
