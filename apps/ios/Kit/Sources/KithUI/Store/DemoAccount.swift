import KithKit
import Foundation

/// DEBUG-only screenshot hook: launch with `-kithDemoScreens <name>` and the app shows real screens over a
/// fixed, host-less account (`AccountStore.demo`). CI (`.github/workflows/screens.yml`) drives it.
/// A new screen adds one case to the switch in `KithApp.showDemoScreen`. Release builds see `active == false`.
public enum DemoScreens {
    #if DEBUG
    /// The screen asked for with `-kithDemoScreens <name>`.
    public static let name: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-kithDemoScreens"), args.indices.contains(i + 1) else { return nil }
        return args[i + 1]
    }()
    public static var active: Bool { name != nil }
    /// The bot the `chat` demo opens.
    public static let chatBotId = "coder"
    /// What the Crew dock starts with: `crew-typing` shows it mid-search.
    public static var query: String { name == "crew-typing" ? "co" : "" }
    #else
    public static var active: Bool { false }
    public static let chatBotId = "coder"
    public static var name: String? { nil }
    public static var query: String { "" }
    #endif
}

#if DEBUG

/// A fixed, host-less account for CI screenshots (`-kithDemoScreens` in the app): one online computer with
/// a few bots in different states. Nothing here connects; the store is never made active.
extension AccountStore {
    @MainActor
    public static func demo(storage: SharedStore.Context) -> AccountStore {
        let key = Data((0..<32).map { UInt8($0 + 1) })
        let encoded = key.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let mac = Computer(id: RelayCrypto.computerId(signKey: key), name: "Studio Mac", signKey: encoded, device: "macmini")
        storage.computers = [mac]
        let accounts = AccountStore(storage: storage, cloud: nil) { computer in
            // Never answers: the demo shows a fixed roster, not a connection.
            BotStore(computer: computer, storage: storage) {
                try await Task.sleep(for: .seconds(86_400))
                throw CancellationError()
            }
        }
        accounts.setActive(false)
        guard let store = accounts.store(for: mac.id) else { return accounts }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func bot(_ id: String, _ name: String, kind: String = "agent", status: String = "idle", unread: Int = 0,
                 last: String? = nil, minutesAgo: Int64 = 5, members: [String] = [], pinned: Bool = false) -> Bot? {
            var json: [String: Any] = [
                "id": id, "name": name, "kind": kind, "rev": 1, "status": status, "unread": unread,
                "members": members, "pinned": pinned, "lastAt": now - minutesAgo * 60_000,
            ]
            if let last { json["lastMessage"] = last }
            return (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? JSONDecoder().decode(Bot.self, from: $0) }
        }
        let bots = [
            bot("ada", "Ada", status: "needsInput", unread: 3, last: "Can I run the migration on staging?", minutesAgo: 2, pinned: true),
            bot("remy", "Remy", status: "working", last: "Reading the failing test output", minutesAgo: 1),
            bot("nova", "Nova", last: "Left off: run kith doctor next", minutesAgo: 180),
            bot("pip", "Pip", unread: 1, last: "Draft is in the shared folder", minutesAgo: 45),
            bot("team", "Release crew", kind: "group", unread: 2, last: "Ada: the build is green", minutesAgo: 12, members: ["ada", "remy", "pip"]),
        ].compactMap { $0 }
        for b in bots { store.bots[b.id] = b }
        seedChat(store, now: now)
        store.connection = .online
        store.caughtUp = true
        return accounts
    }
}

extension AccountStore {
    /// The `chat` demo: a bot with two folded threads, one held by a terminal, and the newest one open with a
    /// tool row, a reply and a question waiting.
    @MainActor
    static func seedChat(_ store: BotStore, now: Int64) {
        let id = DemoScreens.chatBotId
        func decode<T: Decodable>(_ json: [String: Any]) -> T? {
            (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
        }
        let minute: Int64 = 60_000
        if let coder: Bot = decode([
            "id": id, "name": "Coder", "kind": "agent", "rev": 1, "status": "idle", "unread": 0, "members": [String](),
            "pinned": false, "lastAt": now - 2 * minute, "avatarColor": "kith:sky", "backend": "claude", "cwd": "/Users/kai/kith",
            "folder": ["kind": "project", "project": "kith", "path": "/Users/kai/kith", "name": "kith"],
        ]) { store.bots[id] = coder }

        var seq: Int64 = 0
        func entry(_ kind: String, root: String? = nil, ago: Int64, data: [String: Any]) -> Entry? {
            seq += 1
            var json: [String: Any] = ["id": "d\(seq)", "seq": seq, "botId": id, "rev": seq, "kind": kind, "turn": seq,
                                       "data": data, "createdAt": now - ago * minute, "updatedAt": now - ago * minute]
            if let root { json["threadId"] = root }
            return decode(json)
        }
        func task(_ n: Int64, _ text: String, ago: Int64, thread: [String: Any]) -> Entry? {
            seq = n * 100
            return entry("user", ago: ago, data: ["text": text, "task": true, "thread": thread])
        }
        func summary(_ count: Int, ago: Int64, unread: Int = 0, extra: [String: Any] = [:]) -> [String: Any] {
            ["count": count, "lastAt": now - ago * minute, "authors": [id], "unread": unread].merging(extra) { $1 }
        }
        func reply(_ root: Entry?, ago: Int64, _ text: String) -> Entry? {
            entry("agent", root: root?.id, ago: ago, data: ["text": text, "final": true])
        }

        var list: [Entry] = []
        var threads: [String: PlaceFolder] = [:]
        let held = task(1, "Add --resume to the kith CLI", ago: 300, thread: summary(2, ago: 290, extra: [
            "origin": "terminal", "liveWriter": "terminal", "liveBusy": true,
        ]))
        let swap = task(2, "Why is swap so high on the mini?", ago: 200, thread: summary(2, ago: 190))
        let board = task(3, "Add the waits section to Board", ago: 90, thread: summary(5, ago: 60, unread: 1))
        let open = task(4, "The sleep notice fires twice, fix it", ago: 8, thread: summary(4, ago: 2))
        for root in [held, swap, board, open].compactMap({ $0 }) {
            list.append(root)
            threads[BotStore.threadFolderKey(id, root.id)] = PlaceFolder(kind: root.id == held?.id ? "folder" : "project",
                                                                         project: "kith", path: "/Users/kai/kith", name: root.id == held?.id ? "kith" : "kith")
        }
        if let held {
            list += [
                entry("notice", root: held.id, ago: 299, data: ["text": "Started in the terminal", "writerChange": "startedInTerminal"]),
                reply(held, ago: 290, "Added the flag; trying it against a saved session."),
            ].compactMap { $0 }
        }
        if let swap {
            list += [reply(swap, ago: 195, "Chrome is holding 6 GB of compressed pages. Quitting it frees most of the swap.")].compactMap { $0 }
        }
        if let board {
            list += [
                entry("tool", root: board.id, ago: 80, data: ["toolKind": "edit", "title": "BoardView.swift", "status": "completed",
                                                              "diffs": [["path": "BoardView.swift", "added": 42, "removed": 3, "isNew": false, "startLine": 1, "patch": "+waits"]]]),
                reply(board, ago: 60, "The waits section is in, below left off."),
            ].compactMap { $0 }
        }
        if let open {
            list += [
                reply(open, ago: 7, "Found it: the sweep and the wake hook both post the notice."),
                entry("tool", root: open.id, ago: 6, data: ["toolKind": "edit", "title": "kith-sessions.py", "status": "completed",
                                                            "diffs": [["path": "kith-sessions.py", "added": 6, "removed": 2, "isNew": false, "startLine": 1, "patch": "+skip"]]]),
                entry("tool", root: open.id, ago: 5, data: ["toolKind": "execute", "title": "swift test", "status": "completed", "output": "42 tests passed"]),
                reply(open, ago: 3, "One fix in two files. Want me to run the host tests too?"),
                entry("permission", root: open.id, ago: 2, data: [
                    "title": "cargo test -p kith-host", "toolKind": "execute", "status": "pending", "cwd": "/Users/kai/kith",
                    "options": [["optionId": "o1", "name": "Allow once", "kind": "allow_once"],
                                ["optionId": "o2", "name": "Always allow", "kind": "allow_always"],
                                ["optionId": "o3", "name": "Deny", "kind": "reject_once"]],
                ]),
            ].compactMap { $0 }
        }
        store.entries[id] = list
        store.threadFolders.merge(threads) { $1 }
    }
}
#endif
