import KithKit
import SwiftUI

/// Pure mapping from the store's entries onto the redesign's components: the thread chip, tool rows and the order
/// of an open thread. No views here, so it is tested.
enum ThreadFeed {
    /// Tool calls in a row beyond this many fold into "N earlier steps" (a long task can run hundreds).
    static let visibleSteps = 4

    // MARK: place

    static func place(_ folder: PlaceFolder?) -> ThreadChipModel.Place? {
        guard let folder, !folder.name.isEmpty else { return nil }
        return folder.kind == "project" ? .project(folder.name) : .folder(folder.name)
    }

    // MARK: chip

    /// What hangs under a task's first message. `yourTurn`: a question waits for the reader.
    static func chip(face: CrewFace, tint: AgentTint, count: Int, unread: Int?, lastAt: Int64, place: PlaceFolder?,
                     yourTurn: Bool, now: Date = .now) -> ThreadChipModel {
        ThreadChipModel(face: face, replies: count, newReplies: max(0, unread ?? 0),
                        time: RelativeTime.day(Date(milliseconds: lastAt), now: now), place: self.place(place),
                        yourTurn: yourTurn, tint: tint)
    }

    // MARK: tool rows

    private static let verbs = [
        "read": "Read", "edit": "Edited", "delete": "Deleted", "move": "Moved", "search": "Searched",
        "execute": "Ran", "think": "Thought", "fetch": "Fetched",
    ]

    /// One tool entry as one row: "Edited kith-sessions.py  +6 -2". The sheet gets the command and what it printed.
    static func toolRow(_ entry: Entry) -> ToolCallRowModel {
        let d = entry.data
        let verb = verbs[d.toolKind ?? ""] ?? "Used"
        let diffs = d.diffs ?? []
        let object: String
        if let first = diffs.first {
            object = (first.path as NSString).lastPathComponent + (diffs.count > 1 ? " +\(diffs.count - 1)" : "")
        } else {
            object = (d.title ?? "").split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        }
        let result: ToolCallRowModel.Result? = switch d.status {
        case "completed": .text(diffs.isEmpty ? "done" : "+\(diffs.map(\.added).reduce(0, +)) -\(diffs.map(\.removed).reduce(0, +))")
        case "failed": .error("failed")
        default: nil
        }
        let command = d.command?.nilIfEmpty ?? (d.toolKind == "execute" ? d.title?.nilIfEmpty : nil)
        let patches = diffs.map(\.patch).joined(separator: "\n")
        let output = [d.output?.nilIfEmpty, patches.nilIfEmpty].compactMap { $0 }.joined(separator: "\n\n").nilIfEmpty
        return ToolCallRowModel(verb: verb, object: object, result: result, command: command, output: output)
    }

    // MARK: open thread

    /// What an open thread shows under its first message, in order.
    enum Reply: Identifiable, Equatable {
        case entry(Entry, groupStart: Bool)
        case tool(Entry)
        /// A run of tool calls longer than `visibleSteps`: the older ones fold into this line.
        case earlier(count: Int, id: String)

        var id: String {
            switch self {
            case .entry(let e, _), .tool(let e): e.id
            case .earlier(_, let id): id
            }
        }
    }

    /// Chat-visible replies and tool calls. Thinking, plans and the like stay in "Full conversation".
    static func replies(_ entries: [Entry]) -> [Reply] {
        var out: [Reply] = []
        var run: [Entry] = []
        var lastAuthor: String?
        func flush() {
            guard !run.isEmpty else { return }
            if run.count > visibleSteps, let first = run.first {
                out.append(.earlier(count: run.count - visibleSteps, id: "earlier-\(first.id)"))
                run.suffix(visibleSteps).forEach { out.append(.tool($0)) }
            } else {
                run.forEach { out.append(.tool($0)) }
            }
            run = []
        }
        for e in entries {
            if e.kind == "tool" {
                run.append(e)
                continue
            }
            guard e.isChat else { continue }
            flush()
            let author = e.kind == "user" ? "user" : e.kind == "agent" ? "agent:\(e.data.author ?? "")" : e.kind
            out.append(.entry(e, groupStart: author != lastAuthor))
            lastAuthor = (author == "user" || e.kind == "agent") ? author : nil
        }
        flush()
        return out
    }

    /// A question waits on the reader: a permission card still pending.
    static func hasQuestion(_ replies: [Entry]) -> Bool {
        replies.contains { $0.kind == "permission" && $0.data.status == "pending" }
    }
}

fileprivate extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
