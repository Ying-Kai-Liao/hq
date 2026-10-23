import Foundation

// Tasks (host `chat/tasks.rs`): each burst of the user's chat with a bot is a task. Its first message is a root in
// the chat (`data.task`); the bot's answers and the rest of the burst are its thread. The chat shows a task inline
// while it's going and folds it into a card once it's idle.

public enum TaskStatus: Sendable {
    case working, needsYou, stopped, done

    public var label: String {
        switch self {
        case .working: "Working"
        case .needsYou: "Needs you"
        case .stopped: "Stopped"
        case .done: "Done"
        }
    }

    public var isBusy: Bool { self == .working || self == .needsYou }
}

public enum Tasks {
    /// The host's `tasks::IDLE_MS`: a task idle this long is over, and folds.
    public static let idleMs: Int64 = 10 * 60_000

    /// The newest task in a chat: where a message without a thread goes on, and what the chat's Stop stops.
    public static func current(in chat: [Entry]) -> Entry? {
        chat.last(where: \.isTask)
    }

    /// The chat with its tasks' threads (other threads left out): what a voice call hears and reads.
    public static func chatAndTasks(_ all: [Entry]) -> [Entry] {
        let tasks = Set(all.filter(\.isTask).map(\.id))
        return all.filter { $0.threadId.map(tasks.contains) ?? true }
    }

    /// Where the task stands: at work (or waiting on an approval), stopped, or done.
    public static func status(of root: Entry, bot: Bot, replies: [Entry]) -> TaskStatus {
        if bot.isWorking(in: bot.id, thread: root.id) {
            // A prompt in a thread another writer holds is read-only here, so it isn't ours to answer.
            let held = root.data.thread?.isHeldElsewhere == true
            return !held && replies.contains { $0.kind == "permission" && $0.data.status == "pending" } ? .needsYou : .working
        }
        let last = replies.last { $0.kind == "notice" || ($0.kind == "agent" && $0.data.final == true) }
        return last?.kind == "notice" && last?.data.text == "Stopped." ? .stopped : .done
    }

    /// When the task last moved: its newest message, or its start.
    public static func lastAt(_ root: Entry) -> Int64 {
        if let at = root.data.thread?.lastAt, at > 0 { return at }
        return root.createdAt
    }

    /// Whether a task shows inline rather than as a card: while it works or waits on the user, and the newest one
    /// until it has been idle for ten minutes. A choice the user made on this device wins.
    public static func isOpen(_ status: TaskStatus, newest: Bool, lastAt: Int64, now: Int64, choice: Bool? = nil) -> Bool {
        if let choice { return choice }
        return status.isBusy || (newest && now - lastAt < idleMs)
    }

    /// A card's title: the task's first message, on one line.
    public static func title(_ root: Entry) -> String {
        let text = (root.data.text ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return text.isEmpty ? "Task" : text
    }
}

extension Entry {
    /// The first message of a task, in the main chat.
    public var isTask: Bool { kind == "user" && threadId == nil && data.task == true }
}
