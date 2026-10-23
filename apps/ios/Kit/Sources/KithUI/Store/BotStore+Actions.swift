import KithKit
import Foundation
import os

private let log = Logger(subsystem: "com.yingkailiao.kith", category: "BotStore")

extension BotStore {
    /// The client while the link is really up: not during a reconnect the grace period keeps
    /// quiet, nor right after coming back to the foreground, when the old link is already gone.
    var live: HostClient? {
        connection == .online && heldDrop == nil && eventsTask != nil && !retired ? client : nil
    }

    /// The client once the link is up. A reconnect in progress is waited out (headers show it,
    /// see `shownConnection`), and an unreachable computer gets one fresh attempt first. A computer
    /// that is off or refusing this device throws at once; so does a reconnect that outlasts `deadline`.
    func ready(until deadline: ContinuousClock.Instant = .now + BotStore.actionPatience) async throws -> HostClient {
        var counted = false
        var retried = false
        defer { if counted { Motion.animate { waiting -= 1 } } }
        while !retired {
            if let live { return live }
            switch connection {
            case .online, .connecting: break
            case .offline where !retried:
                // The link retries on a backoff of up to 30 s: with someone waiting, try now.
                retried = true
                restartStream()
            case .offline, .unpaired: throw HostError.unreachable
            // The relay reports when it comes back, so there is no attempt of ours to wait for.
            case let .computerOffline(lastSeen): throw HostError.computerOffline(lastSeen: lastSeen)
            case let .unauthorized(message): throw HostError.unauthorized(message)
            }
            guard ContinuousClock.now < deadline else { break }
            if !counted {
                counted = true
                Motion.animate { waiting += 1 }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw HostError.unreachable
    }

    /// Runs `op` once the link is up. With `replay`, only for calls the computer can safely get
    /// twice, a call the link dropped under is tried again after the reconnect.
    func withLink<T>(replay: Bool = false, _ op: @MainActor (HostClient) async throws -> T) async throws -> T {
        let deadline = ContinuousClock.now + Self.actionPatience
        while true {
            let client = try await ready(until: deadline)
            do {
                return try await op(client)
            } catch let error as HostError where replay && error.isTransient && ContinuousClock.now < deadline {
                log.info("retrying after: \(error.localizedDescription)")
                try await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    /// Fire-and-forget actions; only what waiting and retrying couldn't settle reaches the dialog.
    /// `rollback` undoes an optimistic local change when the host refuses or can't be reached.
    private func perform(replay: Bool = false, rollback: (@MainActor () -> Void)? = nil, _ op: @escaping @MainActor (HostClient) async throws -> Void) {
        Task {
            do {
                try await withLink(replay: replay, op)
            } catch {
                rollback?()
                lastError = error.localizedDescription
            }
        }
    }

    /// Stops the bot in its chat, or in the thread on `thread`; its other places keep working.
    public func stop(_ botId: String, thread: String? = nil) { perform(replay: true) { try await $0.stop(botId, thread: thread) } }
    /// Accepts an incoming call; false when another device or the timeout got there first (it is then gone).
    /// On success the call stays listed until `dismissCall`, so the screen can hand over to the call without a gap.
    public func acceptCall(_ call: IncomingCall) async -> Bool {
        if let client, (try? await client.callAccept(call.id)) != nil { return true }
        dismissCall(call.id)
        return false
    }

    public func dismissCall(_ id: String) { incomingCalls.removeAll { $0.id == id } }

    public func declineCall(_ call: IncomingCall) {
        incomingCalls.removeAll { $0.id == call.id }
        perform { try await $0.callDecline(call.id) }
    }

    /// Drops the calls whose ring is over (the host's "missed" may not reach a device that lost the link).
    public func expireCalls() {
        let left = IncomingCalls.expire(incomingCalls)
        if left.count != incomingCalls.count { incomingCalls = left }
    }

    /// The accepted call is live: the agent speaks first (once per call).
    public func greetCall(_ id: String) {
        guard greeted.insert(id).inserted else { return }
        perform { try await $0.callGreet(id) }
    }

    public func logCall(_ botId: String, seconds: Int) { perform { try await $0.logCall(botId, seconds: seconds) } }
    public func newSession(_ botId: String) { perform { try await $0.newSession(botId) } }

    // MARK: remote screen

    /// Takes control from bots (they can still look) or hands it back.
    public func screenTakeover(_ on: Bool) {
        perform(replay: true) { [weak self] in self?.screen = try await $0.screenTakeover(on) }
    }

    /// Quick reactions offered on every message (Slack's hover bar).
    public static let quickReactions = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

    /// Toggles the user's reaction; shown at once, then replaced by the host's copy.
    public func react(_ entry: Entry, _ emoji: String) {
        guard let i = entries[entry.botId]?.firstIndex(where: { $0.id == entry.id }) else { return }
        var reactions = entries[entry.botId]?[i].data.reactions ?? []
        if let at = reactions.firstIndex(of: emoji) { reactions.remove(at: at) } else { reactions.append(emoji) }
        let previous = entries[entry.botId]?[i].data.reactions
        entries[entry.botId]?[i].data.reactions = reactions
        perform(rollback: { [weak self] in
            guard let self, let at = self.entries[entry.botId]?.firstIndex(where: { $0.id == entry.id }) else { return }
            self.entries[entry.botId]?[at].data.reactions = previous
        }) { client in
            let e = try await client.react(entryId: entry.id, emoji: emoji)
            self.upsert(e)
        }
    }

    /// Takes back a message that still waits for its turn; the host marks it cancelled.
    public func unsend(_ entry: Entry) {
        perform { client in
            self.upsert(try await client.unsend(botId: entry.botId, entryId: entry.id))
        }
    }

    public func respond(_ entry: Entry, option: String?) {
        guard answering[entry.id] == nil else { return }
        Motion.animate { answering[entry.id] = option ?? "" }
        Task {
            do {
                try await withLink(replay: true) { try await $0.respondPermission(entryId: entry.id, optionId: option) }
                // The card's own update follows on the events stream; hold the spinner until then.
                try? await Task.sleep(for: .seconds(2))
            } catch {
                lastError = error.localizedDescription
            }
            Motion.animate { answering[entry.id] = nil }
        }
    }

    struct ReadingScope: Hashable {
        let botId: String
        let thread: String?
    }

    /// Views register only while visible in an active scene. Multiple windows may
    /// read the same conversation without unregistering each other.
    func setReading(_ token: UUID, botId: String, thread: String?, active: Bool) {
        if active {
            let scope = ReadingScope(botId: botId, thread: thread)
            readingViews[token] = scope
            if connection == .online { markRead(botId, thread: thread) }
        } else {
            readingViews[token] = nil
        }
    }

    func acknowledgeVisibleConversations(_ botId: String, entry: Entry? = nil) {
        guard connection == .online else { return }
        for scope in Set(readingViews.values) where scope.botId == botId {
            if let entry, (!entry.isChat || entry.threadId != scope.thread) { continue }
            markRead(botId, thread: scope.thread)
        }
    }

    /// The main chat on screen (or the thread on `thread`) is read; the host ignores it
    /// when nothing there is unread.
    public func markRead(_ botId: String, thread: String? = nil) {
        // Entry events may arrive before the roster's unread count. The host is
        // authoritative and treats a redundant scoped acknowledgement as a no-op.
        Task {
            // Opening a cached conversation can race the foreground reconnect.
            // This background acknowledgement must never interrupt the conversation.
            if live == nil {
                try? await Task.sleep(for: Self.initialConnectionGrace)
            }
            guard !Task.isCancelled, isActive, let client = live else { return }
            do {
                try await client.markRead(botId, threadId: thread)
            } catch {
                // The visible scope is acknowledged again when the link recovers.
                log.debug("read acknowledgement deferred: \(error.localizedDescription)")
            }
        }
    }

    /// The roster's "Mark as read": the chat and all its threads.
    public func markAllRead(_ botId: String) {
        guard (bots[botId]?.unread ?? 0) > 0 else { return }
        bots[botId]?.unread = 0
        perform(replay: true) { try await $0.markRead(botId, all: true) }
    }

    /// Changes one setting: shown at once, then sent alone (the host merges it), and put back if the host refuses.
    private func setting<Value: Encodable & Sendable>(_ bot: Bot, _ key: String, _ value: Value, _ path: WritableKeyPath<Bot, Value>) {
        let previous = bots[bot.id]?[keyPath: path]
        bots[bot.id]?[keyPath: path] = value
        perform(replay: true, rollback: { [weak self] in
            if let previous { self?.bots[bot.id]?[keyPath: path] = previous }
        }) { try await $0.updateBotSetting(bot.id, key, value) }
    }

    public func setPinned(_ bot: Bot, _ pinned: Bool) {
        setting(bot, "pinned", pinned, \.pinned)
    }

    /// A palette colour for the bot's body (`AvatarPalette.Swatch.stored`).
    public func setAvatarColor(_ bot: Bot, _ color: String) {
        setting(bot, "avatarColor", color, \.avatarColor)
    }

    public func setHidden(_ bot: Bot, _ hidden: Bool) {
        setting(bot, "hidden", hidden, \.hidden)
    }

    /// Whether the bot may see and use the computer's screen.
    public func setComputer(_ bot: Bot, _ computer: Bool) {
        setting(bot, "computer", computer, \.computer)
    }

    /// Whether the bot uses the memory all bots share.
    public func setSharedMemory(_ bot: Bot, _ shared: Bool) {
        setting(bot, "sharedMemory", Bool?.some(shared), \.sharedMemory)
    }

    /// Whether the bot's harness keeps its own memory on beside Kith's.
    public func setHarnessMemory(_ bot: Bot, _ on: Bool) {
        setting(bot, "harnessMemory", Bool?.some(on), \.harnessMemory)
    }

    /// Saves the user's version of a handoff that hasn't been sent. Whether it did.
    public func editHandoff(_ entry: Entry, text: String) async -> Bool {
        do {
            try await withLink(replay: true) { try await $0.editHandoff(entryId: entry.id, text: text) }
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// Carries on with the bot's current conversation instead of the handoff.
    public func keepConversation(_ entry: Entry) {
        guard answering[entry.id] == nil else { return }
        Motion.animate { answering[entry.id] = "handoff" }
        Task {
            do {
                try await withLink(replay: true) { try await $0.keepConversation(entryId: entry.id) }
            } catch {
                lastError = error.localizedDescription
            }
            Motion.animate { answering[entry.id] = nil }
        }
    }

    public func setFastMode(_ bot: Bot, _ fastMode: Bool) {
        setting(bot, "fastMode", fastMode, \.fastMode)
    }

    // MARK: roster order

    /// Puts the roster in `ids` order (pinned bots still sort first) and sends it; the host
    /// syncs it to every device.
    public func reorder(_ ids: [String]) {
        let before = ids.reduce(into: [String: Int]()) { $0[$1] = bots[$1]?.position }
        for (position, id) in ids.enumerated() { bots[id]?.position = position }
        perform(replay: true, rollback: { [weak self] in
            for (id, position) in before { self?.bots[id]?.position = position }
        }) { try await $0.reorderBots(ids) }
    }

    /// One place up (-1) or down (+1) among bots with the same pin state (VoiceOver).
    public func move(_ botId: String, by offset: Int) {
        var ids = roster.map(\.id)
        guard let i = ids.firstIndex(of: botId), ids.indices.contains(i + offset),
              bots[ids[i + offset]]?.pinned == bots[botId]?.pinned else { return }
        ids.swapAt(i, i + offset)
        reorder(ids)
    }

    public func delete(_ bot: Bot) {
        let kept = entries[bot.id]
        removeComposerDrafts(for: bot.id)
        bots[bot.id] = nil
        entries[bot.id] = nil
        perform(replay: true, rollback: { [weak self] in
            self?.bots[bot.id] = bot
            if let kept { self?.entries[bot.id] = kept }
        }) { try await $0.deleteBot(bot.id) }
    }

    /// Creates a group chat (or opens the one these bots already share) and selects it.
    public func createGroup(name: String, description: String = "", members: [String]) async throws -> Bot {
        let group = try await ready().createGroup(GroupDraft(name: name, description: description, members: members))
        bots[group.id] = group
        selection = group.id
        return group
    }

    public func updateGroup(_ draft: GroupDraft) async throws {
        let group = try await ready().updateGroup(draft)
        bots[group.id] = group
    }

    /// Pages in a thread's replies (the stream only carries recent entries).
    public func loadThread(_ botId: String, root: String) async {
        guard let client else { return }
        let page: (entries: [Entry], folder: PlaceFolder?)
        do {
            page = try await client.threadPage(botId: botId, rootId: root)
        } catch {
            log.error("thread load failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            return
        }
        for e in page.entries { upsert(e) }
        if let folder = page.folder { threadFolders[Self.threadFolderKey(botId, root)] = folder }
    }

    /// The bot-to-bot notices between a chat and a peer. Never `upsert`ed: old notices in the
    /// mirror would break `loadOlder`, which pages from the oldest loaded `seq`.
    public func botConversation(_ botId: String, peer: String) async throws -> [Entry] {
        try await ready().botConversation(botId: botId, peerId: peer)
    }

    public func save(_ draft: BotDraft) async throws -> Bot {
        let client = try await ready()
        let bot = draft.id == nil ? try await client.createBot(draft) : try await client.updateBot(draft)
        bots[bot.id] = bot
        return bot
    }

    public func listDirs(_ path: String?, showHidden: Bool = false) async throws -> DirListing {
        try await ready().listDirs(path, showHidden: showHidden)
    }

    public func refreshUsage() async {
        guard !retired, let client else { return }
        do {
            let u = try await client.usage(refresh: true)
            if !Task.isCancelled { setUsage(u) }
        } catch {
            log.error("usage refresh failed: \(error.localizedDescription)")
            if !Task.isCancelled { lastError = error.localizedDescription }
        }
    }

    public func loadOlder(_ botId: String) async {
        guard let client, !historyComplete.contains(botId) else { return }
        let first: Int64 = chat(botId).first(where: { $0.seq > 0 && $0.seq != Int64.max })?.seq ?? Int64.max
        let older: [Entry]
        do {
            older = try await client.history(botId: botId, beforeSeq: first, limit: 100)
        } catch {
            log.error("older messages failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            return
        }
        if older.count < 100 { historyComplete.insert(botId) }
        for e in older { upsert(e) }
    }
}
