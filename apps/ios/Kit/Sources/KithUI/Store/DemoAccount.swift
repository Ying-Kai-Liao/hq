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
    #else
    public static var active: Bool { false }
    public static var name: String? { nil }
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
        store.connection = .online
        store.caughtUp = true
        return accounts
    }
}
#endif
