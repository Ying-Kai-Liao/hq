import KithKit
import Foundation

/// The folder each place works in (see serve/docs/place-folders.md).
extension BotStore {
    static func threadFolderKey(_ botId: String, _ root: String) -> String { "\(botId)/\(root)" }

    /// Where the bot's own chat (`thread == nil`) or one thread works; nil from a host without place folders.
    public func placeFolder(_ botId: String, thread: String? = nil) -> PlaceFolder? {
        guard let thread else { return bots[botId]?.folder }
        return threadFolders[Self.threadFolderKey(botId, thread)]
    }

    /// Re-reads the folder of each thread of `botId` this device has opened.
    func refreshThreadFolders(_ botId: String) {
        let roots = threadFolders.keys.filter { $0.hasPrefix(botId + "/") }.map { String($0.dropFirst(botId.count + 1)) }
        guard !roots.isEmpty else { return }
        Task { for root in roots { await loadThread(botId, root: root) } }
    }

    public func projects(refresh: Bool = false) async throws -> ProjectList {
        try await ready().projects(refresh: refresh)
    }

    public func recentFolders() async throws -> [RecentFolder] {
        try await ready().recentFolders()
    }

    public func registerProject(id: String, path: String) async throws -> HQProject {
        try await ready().registerProject(id: id, path: path)
    }

    /// Sets (or, with nil, clears) where a place works. A group's lane passes the group as `chat`, `botId` the member.
    /// The host starts the place on a fresh session when its folder changes.
    @discardableResult
    public func setPlaceFolder(_ botId: String, thread: String? = nil, chat: String? = nil, to choice: FolderChoice?) async throws -> PlaceFolder {
        let folder = try await ready().setPlaceFolder(botId: botId, threadId: thread, chat: chat, to: choice)
        if let thread {
            threadFolders[Self.threadFolderKey(botId, thread)] = folder
        } else if chat == nil || chat == botId {
            bots[botId]?.folder = folder
        }
        return folder
    }
}
