import CodyncKit
import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.pokai.Codync", category: "BotStore")

/// Opens the screen viewer, optionally watching a bot that's using the computer.
public struct ScreenRequest: Identifiable, Hashable, Sendable {
    public var watching: String?
    public var id: String { watching ?? "computer" }
    public init(watching: String? = nil) { self.watching = watching }
}

/// One computer's mirror (bots, transcripts) for a client (iPhone app, Mac window), kept by one
/// events stream (catch-up since `rev`, then live) over loopback or the encrypted channel.
/// `AccountStore` holds one per computer.
@MainActor
@Observable
public final class BotStore {
    public enum Connection: Equatable {
        case unpaired
        case connecting
        case online
        /// The relay says the computer isn't connected; messages can wait in its mailbox.
        case computerOffline(lastSeen: Date?)
        /// Can't reach the computer at all (no direct route, no relay).
        case offline(String)
        /// Revoked, lease expired, or the computer's identity changed.
        case unauthorized(String)
    }

    /// How this store reaches its computer.
    public enum Route: Sendable, Hashable {
        /// The Mac's own host, or one through an SSH tunnel.
        case loopback(baseURL: URL, token: String)
        /// The end-to-end encrypted channel (direct or relay), with this context's device key.
        case channel
    }

    public private(set) var computer: Computer
    public let route: Route
    public private(set) var connection: Connection = .connecting
    private static let dropGrace: Duration = .seconds(5)
    private static let initialConnectionGrace: Duration = .seconds(1)
    private var heldDrop: Connection?
    private var dropTimer: Task<Void, Never>?
    /// How long an action waits for a reconnect before it gives up.
    private static let actionPatience: Duration = .seconds(20)
    /// Actions waiting for the link to come back.
    private var waiting = 0
    public private(set) var hostRoute: HostRoute?
    public private(set) var client: HostClient?
    public private(set) var hello: Hello?
    /// The host's version and `minApp`, kept even when the rest of its `hello` can't be read.
    public private(set) var hostVersion: HostVersion?
    public private(set) var bots: [String: Bot] = [:]
    public private(set) var entries: [String: [Entry]] = [:]
    public private(set) var usage: Usage
    /// The computer's remote screen (`nil`: the host predates it).
    public private(set) var screen: ScreenState?
    /// Devices asking this computer for access (loopback only: the Mac approves them).
    public private(set) var accessRequests: [AccessRequest] = []
    /// The host's cloud connection (loopback only).
    public private(set) var cloud: CloudStatus?
    /// Installed on the computer, for the Plugins screen and bot settings.
    public private(set) var installedConnectors: [InstalledConnector] = []
    public private(set) var installedSkills: [InstalledSkill] = []
    /// Bots whose older history has been fully paged in.
    public private(set) var historyComplete: Set<String> = []
    public var routineDrafts: [String: String] = [:]
    public var lastError: String?
    /// The open conversation (iOS navigation path / Mac sidebar selection).
    public var selection: String?
    /// The phone's profile sheet (computers, usage); `codync://computers` opens it.
    public var showProfile = false
    /// The Plugins screen on its own; `codync://plugins` opens it.
    public var showPlugins = false
    /// The remote screen viewer (iPhone); `codync://screen` opens it.
    public var screenRequest: ScreenRequest?

    // Platform hooks (push registration, Live Activities, widgets).
    /// Each time the channel (or loopback) becomes ready.
    public var onConnected: (@MainActor (BotStore) -> Void)?
    public var onBotUpdated: (@MainActor (Bot) -> Void)?
    public var onUsageChanged: (@MainActor (ComputerID, Usage) -> Void)?
    public var onSent: (@MainActor (Bot) -> Void)?
    /// A bot appeared, changed or went away.
    var onRosterChanged: (@MainActor () -> Void)?
    /// The computer's addresses or keys changed (merged from its `hello`); persist it.
    var onComputerChanged: (@MainActor (Computer) -> Void)?

    /// `ios` clients suppress pushes while connected; others don't.
    private let clientKind: String
    public let storage: SharedStore.Context
    private let makeTransport: @MainActor () async throws -> any HostTransport
    private var transport: (any HostTransport)?
    private var retired = false
    /// Files of messages not delivered yet (by client nonce), kept for a retry.
    @ObservationIgnored private var outgoingFiles: [String: [OutgoingFile]] = [:]

    private var rev: Int64 = 0
    private var hostId: String?
    private var streamTask: Task<Void, Never>?
    private var eventsTask: Task<Void, Never>?
    private var isActive = true
    private struct VoiceCall {
        let botId: String
        let startRev: Int64
        let speak: @MainActor (String) -> Void
        /// A notice from the computer (approval needed), as opposed to the bot's reply.
        let announce: @MainActor (String) -> Void
        let end: @MainActor () -> Void
    }
    @ObservationIgnored private var voiceCalls: [UUID: VoiceCall] = [:]
    private var saveTask: Task<Void, Never>?
    private var rewound = false
    /// Events stayed undecodable after the rewind.
    private var unreadable = false
    /// This app's marketing version, compared with the host's `minApp`.
    private let appVersion: String
    /// While one side needs an update there's nothing to sync; `hello` is asked again this often.
    private static let mismatchRecheck: Duration = .seconds(30)

    /// `.channel` loads this context's `DeviceIdentity` itself.
    public convenience init(computer: Computer, route: Route, clientKind: String, storage: SharedStore.Context) {
        let make: @MainActor () async throws -> any HostTransport = switch route {
        case let .loopback(baseURL, token):
            { LoopbackTransport(baseURL: baseURL, token: token) }
        case .channel:
            { try await HostConnector.connect(computer, identity: try DeviceIdentity.load(context: storage)) }
        }
        self.init(computer: computer, route: route, clientKind: clientKind, storage: storage, transport: make)
    }

    init(computer: Computer, route: Route, clientKind: String, storage: SharedStore.Context,
         appVersion: String = AppVersion.current,
         transport: @escaping @MainActor () async throws -> any HostTransport) {
        self.appVersion = appVersion
        self.computer = computer
        self.route = route
        self.clientKind = clientKind
        self.storage = storage
        makeTransport = transport
        usage = storage.usage[computer.id] ?? Usage()
        loadCache()
    }

    // MARK: derived

    /// Offline in any way: the computer is off, unreachable, or refuses this device.
    public var isOffline: Bool {
        switch connection {
        case .computerOffline, .offline, .unauthorized: true
        default: false
        }
    }

    /// Offline, but sends can wait in the relay mailbox until the computer is back.
    public var canQueue: Bool {
        // Only the warning is delayed; relay delivery can queue during that grace.
        if case .computerOffline = heldDrop ?? connection { computer.boxKey != nil && transport is any RemoteTransport } else { false }
    }

    /// What headers show: a reconnect the grace period keeps quiet reads "Connecting…"
    /// as soon as an action is waiting on it.
    public var shownConnection: Connection { waiting > 0 && connection == .online ? .connecting : connection }

    public var hostName: String { hello?.name ?? computer.name }

    /// Which side must update before this app and the host can work together
    /// (docs/reference/compatibility.md). `nil` until the host has answered, and whenever
    /// a version can't be read: an unknown is never a reason to lock someone out.
    public var mismatch: VersionMismatch? {
        guard let hostVersion else { return nil }
        if let found = VersionMismatch.check(app: appVersion, hostVersion: hostVersion.version, minApp: hostVersion.minApp) {
            return found
        }
        // The host sends data this app can't read and is newer: this app is behind,
        // whatever the host's `minApp` says.
        if unreadable, AppVersion.isBelow(appVersion, hostVersion.version) {
            return .updateApp(minimum: hostVersion.version)
        }
        return nil
    }

    /// Roster order: pinned first (manual order not tracked yet), then most recent activity.
    public var roster: [Bot] {
        bots.values.filter { !$0.hidden }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            return $0.lastAt > $1.lastAt
        }
    }

    /// Display name for a harness id, as the host reports it (falls back to the built-in list).
    public func backendName(_ id: String) -> String {
        hello?.backends.first { $0.id == id }?.name ?? BackendInfo.name(id)
    }

    public var hiddenBots: [Bot] { bots.values.filter(\.hidden).sorted { $0.name < $1.name } }

    /// A bot's or group's main chat (thread replies are left out).
    public func chat(_ botId: String) -> [Entry] { (entries[botId] ?? []).filter { $0.threadId == nil } }

    /// Everything in a chat, threads included (the full conversation).
    public func allEntries(_ botId: String) -> [Entry] { entries[botId] ?? [] }

    /// The replies in the thread on `root`, oldest first.
    public func replies(_ botId: String, root: String) -> [Entry] { (entries[botId] ?? []).filter { $0.threadId == root } }

    /// A group's bots that still exist.
    public func members(of group: Bot) -> [Bot] { group.members.compactMap { bots[$0] } }

    /// Display name of an entry's author in a group chat.
    public func authorName(_ id: String?) -> String { id.flatMap { bots[$0]?.name } ?? "A deleted bot" }

    func updateComputer(_ change: (inout Computer) -> Void) {
        var c = computer
        change(&c)
        guard c != computer else { return }
        computer = c
        onComputerChanged?(c)
    }

    private func resetMirror() {
        bots = [:]
        entries = entries.mapValues { $0.filter { $0.id.hasPrefix("local-") } }.filter { !$0.value.isEmpty }
        selection = nil
        onRosterChanged?()
        rev = 0
        hostId = nil
        historyComplete = []
        screen = nil
        saveCache()
    }

    // MARK: lifecycle

    /// Permanently detach a store (account switch, computer removed). Late async
    /// callbacks still hold it, but it writes nothing and calls no hooks anymore.
    public func retire() {
        let calls = Array(voiceCalls.values)
        voiceCalls.removeAll()
        setActive(false)
        retired = true
        for call in calls { call.end() }
        saveTask?.cancel()
        dropTimer?.cancel()
        onConnected = nil
        onBotUpdated = nil
        onUsageChanged = nil
        onSent = nil
        onRosterChanged = nil
        onComputerChanged = nil
        client = nil
        selection = nil
        screenRequest = nil
        showProfile = false
        showPlugins = false
    }

    public func setActive(_ active: Bool) {
        guard !retired else { return }
        isActive = active
        if active {
            // Returning to the foreground must not interrupt a live call's sends.
            if voiceCalls.isEmpty || streamTask == nil { restartStream() }
        } else if voiceCalls.isEmpty {
            // Disconnect so the host knows we're gone and sends pushes instead.
            stopTransport()
            saveCache()
        }
    }

    public func restartStream() {
        guard isActive || !voiceCalls.isEmpty, !retired else { return }
        stopTransport()
        if connection != .online { setConnection(.connecting) }
        streamTask = Task { [weak self] in await self?.runStream() }
    }

    /// Audio owns this subscription, so background calls don't depend on SwiftUI updates.
    func beginVoiceCall(_ id: UUID, botId: String, speak: @escaping @MainActor (String) -> Void,
                        announce: (@MainActor (String) -> Void)? = nil, end: @escaping @MainActor () -> Void) {
        guard !retired, voiceCalls[id] == nil else { return }
        voiceCalls[id] = VoiceCall(botId: botId, startRev: rev, speak: speak, announce: announce ?? speak, end: end)
        if streamTask == nil { restartStream() }
    }

    func endVoiceCall(_ id: UUID) {
        guard voiceCalls.removeValue(forKey: id) != nil else { return }
        if !isActive && voiceCalls.isEmpty {
            stopTransport()
            saveCache()
        }
    }

    private func stopTransport() {
        streamTask?.cancel()
        streamTask = nil
        eventsTask?.cancel()
        eventsTask = nil
        dropTimer?.cancel()
        dropTimer = nil
        heldDrop = nil
        if let remote = transport as? any RemoteTransport {
            Task { await remote.shutdown() }
        }
        transport = nil
    }

    private func runStream() async {
        var backoff: Double = 1
        var transport: any HostTransport
        while true {
            do {
                transport = try await makeTransport()
                break
            } catch HostError.unauthorized(let message) {
                if !Task.isCancelled, !retired { setConnection(.unauthorized(message)) }
                return
            } catch {
                guard !Task.isCancelled, !retired else { return }
                setConnection(.offline(error.localizedDescription))
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 30)
                guard !Task.isCancelled else { return }
            }
        }
        guard !Task.isCancelled, !retired else {
            if let remote = transport as? any RemoteTransport { await remote.shutdown() }
            return
        }
        self.transport = transport
        let client = HostClient(transport: transport)
        self.client = client
        if let remote = transport as? any RemoteTransport { watch(remote) }
        for await state in transport.states() {
            guard !Task.isCancelled, !retired else { return }
            switch state {
            case let .ready(route):
                setHostRoute(route)
                if eventsTask == nil {
                    if connection != .online { setConnection(.connecting) }
                    eventsTask = Task { [weak self] in await self?.runEvents(client) }
                    // Mailbox outcomes that happened while this app wasn't listening (§10.2).
                    if let remote = transport as? any RemoteTransport {
                        Task { [weak self] in await self?.reconcileQueued(remote) }
                    }
                }
                onConnected?(self)
            case .connecting:
                stopEvents()
                setConnection(.connecting)
            case let .hostOffline(lastSeen):
                stopEvents()
                setConnection(.computerOffline(lastSeen: lastSeen))
                if let remote = transport as? any RemoteTransport {
                    Task { [weak self] in await self?.reconcileQueued(remote) }
                }
            case let .unauthorized(message):
                stopEvents()
                setConnection(.unauthorized(message))
            case let .failed(message):
                stopEvents()
                setConnection(.offline(message))
            }
        }
    }

    /// Connection changes animate wherever they show (banners, headers, captions, rows).
    /// Give initial connection failures a second to recover and online drops five seconds.
    /// Relay presence can lag a reconnect, so "computer offline" gets the same grace.
    /// Authorization failures still show immediately.
    private func setConnection(_ new: Connection) {
        let transient = switch new {
        case .connecting, .offline, .computerOffline: true
        default: false
        }
        let recovering = new == .online && (connection != .online || heldDrop != nil)
        let initialFailure = connection == .connecting && transient && new != .connecting
        if transient && (connection == .online || initialFailure) {
            let grace = connection == .online ? Self.dropGrace : Self.initialConnectionGrace
            heldDrop = new
            if dropTimer == nil {
                dropTimer = Task { [weak self] in
                    try? await Task.sleep(for: grace)
                    guard !Task.isCancelled, let self, let held = self.heldDrop else { return }
                    self.dropTimer = nil
                    self.heldDrop = nil
                    Motion.animate { self.connection = held }
                }
            }
            return
        }
        dropTimer?.cancel()
        dropTimer = nil
        heldDrop = nil
        if new != connection { Motion.animate { connection = new } }
        if recovering {
            for scope in Set(readingViews.values) { markRead(scope.botId, thread: scope.thread) }
        }
    }

    private func setHostRoute(_ new: HostRoute?) {
        guard new != hostRoute else { return }
        Motion.animate { hostRoute = new }
    }

    private func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
        setHostRoute(nil)
    }

    /// The channel's side streams: merged computer info and mailbox outcomes.
    private func watch(_ remote: any RemoteTransport) {
        let updates = remote.computerUpdates()
        let mailbox = remote.mailboxEvents()
        Task { [weak self] in
            for await computer in updates {
                guard let self, !self.retired else { return }
                // The color is picked on this device; the transport's copy may be older.
                self.updateComputer { current in
                    let color = current.color
                    current = computer
                    current.color = color
                }
            }
        }
        Task { [weak self] in
            for await event in mailbox {
                guard let self, !self.retired else { return }
                self.applyMailbox(event)
            }
        }
    }

    /// Events (catch-up since `rev`, then live) for as long as the link stays ready.
    private func runEvents(_ client: HostClient) async {
        var backoff: Double = 1
        while !Task.isCancelled {
            do {
                try await refreshHello(client)
                guard !Task.isCancelled, !retired else { return }
                if mismatch != nil {
                    // Reached, but nothing to sync until one side updates. A host update restarts
                    // the link (and this loop) anyway; this catches one that doesn't.
                    setConnection(.online)
                    try await Task.sleep(for: Self.mismatchRecheck)
                    continue
                }
                if case .loopback = route {
                    accessRequests = (try? await client.accessRequests()) ?? accessRequests
                    cloud = (try? await client.cloudStatus()) ?? cloud
                }
                for try await event in client.events(since: rev, client: clientKind) {
                    guard !Task.isCancelled, !retired else { return }
                    setConnection(.online)
                    backoff = 1
                    apply(event)
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled || retired { return }
                log.info("stream ended: \(error.localizedDescription)")
                if case let HostError.unauthorized(message) = error {
                    setConnection(.unauthorized(message))
                    return
                }
                // On the channel the link state speaks for itself; loopback has no other signal.
                if case .loopback = route {
                    if case HostError.http(401, _) = error {
                        setConnection(.offline(error.localizedDescription))
                        return
                    }
                    setConnection(.offline(error.localizedDescription))
                }
            }
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 20)
        }
    }

    /// Asked on every (re)connect: the host may have been updated while this app was away.
    private func refreshHello(_ client: HostClient) async throws {
        let h: Hello
        do {
            h = try await client.hello()
        } catch let error as DecodingError {
            // Its version and `minApp` still say which side to update.
            let version: HostVersion = try await client.call("hello")
            guard !Task.isCancelled, !retired else { return }
            log.error("undecodable hello from host \(version.version)")
            noteHostVersion(version)
            Motion.animate { unreadable = true }
            if mismatch == nil { throw error }
            return
        }
        guard !Task.isCancelled, !retired else { return }
        // hello first: whatever the version change shows (notices, reminders) reads it.
        hello = h
        noteHostVersion(HostVersion(version: h.version, minApp: h.minApp))
        if case .loopback = route {
            updateComputer { c in
                c.name = h.name
                if let device = h.device { c.device = device }
            }
        }
    }

    private func noteHostVersion(_ new: HostVersion) {
        let cached = cacheStamp.map { $0 != "\(Self.appBuild)/\(new.version)" } ?? false
        if cached || (hostVersion.map { $0.version != new.version } ?? false) {
            // A different host version or app build: data may carry new fields, so fetch it all again.
            rev = 0
            rewound = false
            unreadable = false
        }
        cacheStamp = nil
        // An update notice may appear or go away with it.
        if new != hostVersion { Motion.animate { hostVersion = new } }
    }

    private func apply(_ event: HostEvent) {
        switch event {
        case let .hello(id, hostRev, newUsage, newScreen):
            if let hostId, hostId != id {
                // Different host database: start over.
                resetMirror()
            }
            hostId = id
            setUsage(newUsage)
            screen = newScreen
            if hostRev < rev { rev = 0 }
        case let .bot(bot):
            let neededInput = bots[bot.id]?.needsInput == true
            bots[bot.id] = bot
            bump(bot.rev)
            onBotUpdated?(bot)
            onRosterChanged?()
            if bot.unread > 0 { acknowledgeVisibleConversations(bot.id) }
            if bot.needsInput && !neededInput {
                for call in Array(voiceCalls.values) where call.botId == bot.id {
                    call.announce("\(bot.name) needs your approval in the chat.")
                }
            }
        case let .botDeleted(id, r):
            bots[id] = nil
            entries[id] = nil
            bump(r)
            if selection == id { selection = nil }
            onRosterChanged?()
        case let .entry(e):
            let wasFinal = entries[e.botId]?.first(where: { $0.id == e.id })?.data.final == true
            upsert(e)
            bump(e.rev)
            acknowledgeVisibleConversations(e.botId, entry: e)
            if e.kind == "agent", e.threadId == nil, e.data.final == true, !wasFinal, let text = e.data.text {
                for call in Array(voiceCalls.values) where call.botId == e.botId && e.rev > call.startRev {
                    call.speak(text)
                }
            }
        case let .usage(u):
            setUsage(u)
        case let .screen(s):
            screen = s
        case let .accessRequests(requests):
            accessRequests = requests
        case let .cloud(status):
            cloud = status
        case .resync:
            restartEvents()
        case let .undecodable(type):
            // Never skip past data we couldn't read: rewind once and fetch everything again.
            log.error("undecodable \(type) event")
            if !rewound {
                rewound = true
                rev = 0
                restartEvents()
            } else if !unreadable {
                Motion.animate { unreadable = true }
                // A newer host this app can't follow: stop syncing and ask for an update.
                if mismatch != nil { restartEvents() }
            }
        }
        scheduleSave()
    }

    /// Resubscribes from the current `rev` on the same link.
    private func restartEvents() {
        guard let client, eventsTask != nil else { return }
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in await self?.runEvents(client) }
    }

    private func bump(_ r: Int64) { rev = max(rev, r) }

    private func upsert(_ e: Entry) {
        var list = entries[e.botId] ?? []
        if let i = list.firstIndex(where: { $0.id == e.id }) {
            // A late API response mustn't undo a newer SSE update.
            guard e.rev >= list[i].rev else { return }
            list[i] = e
        } else {
            // Replace the optimistic copy of a message we sent.
            if e.kind == "user", let nonce = e.data.clientNonce, !nonce.isEmpty {
                list.removeAll { $0.id == "local-\(nonce)" }
            }
            if let last = list.last, last.seq > e.seq, e.seq > 0 {
                let i = list.firstIndex { $0.seq > e.seq } ?? list.endIndex
                list.insert(e, at: i)
            } else {
                list.append(e)
            }
        }
        entries[e.botId] = list
    }

    private func setUsage(_ u: Usage) {
        guard u != usage, !retired else { return }
        usage = u
        storage.usage[computer.id] = u
        onUsageChanged?(computer.id, u)
    }

    // MARK: actions

    /// The client while the link is really up: not during a reconnect the grace period keeps
    /// quiet, nor right after coming back to the foreground, when the old link is already gone.
    private var live: HostClient? {
        connection == .online && heldDrop == nil && eventsTask != nil && !retired ? client : nil
    }

    /// The client once the link is up. A reconnect in progress is waited out (headers show it,
    /// see `shownConnection`), and an unreachable computer gets one fresh attempt first. A computer
    /// that is off or refusing this device throws at once; so does a reconnect that outlasts `deadline`.
    private func ready(until deadline: ContinuousClock.Instant = .now + BotStore.actionPatience) async throws -> HostClient {
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
    private func withLink<T>(replay: Bool = false, _ op: @MainActor (HostClient) async throws -> T) async throws -> T {
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

    /// `thread`: reply in the thread on that main-chat message.
    public func send(_ text: String, to botId: String, thread: String? = nil, files: [OutgoingFile] = []) {
        send(text, to: botId, thread: thread, nonce: UUID().uuidString, files: files)
    }

    private func send(_ text: String, to botId: String, thread: String?, nonce: String, files: [OutgoingFile] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !files.isEmpty, !retired else { return }
        var data = EntryData(text: trimmed, status: "sending", clientNonce: nonce)
        if !files.isEmpty {
            data.attachments = files.map { Attachment(id: $0.id.uuidString, name: $0.name, size: Int64($0.data.count)) }
            outgoingFiles[nonce] = files
        }
        let local = Entry(
            id: "local-\(nonce)", seq: Int64.max, botId: botId, threadId: thread, rev: 0, kind: "user",
            turn: 0, data: data, createdAt: Int64(Date.now.timeIntervalSince1970 * 1000), updatedAt: 0
        )
        upsert(local)
        storage.lastComputerId = computer.id
        // The relay mailbox holds text only: files wait for the computer.
        if canQueue, files.isEmpty, let remote = transport as? any RemoteTransport {
            enqueue(remote, text: trimmed, botId: botId, thread: thread, nonce: nonce)
            return
        }
        deliver(trimmed, botId: botId, thread: thread, nonce: nonce)
    }

    private func deliver(_ text: String, botId: String, thread: String?, nonce: String) {
        Task {
            do {
                // Safe to repeat: the computer skips a nonce it already has.
                let e = try await withLink(replay: true) { client in
                    var ids: [String]?
                    if let files = self.outgoingFiles[nonce] {
                        // A fresh upload per attempt: a retry never appends to a half-sent file.
                        ids = []
                        for file in files {
                            let id = UUID().uuidString
                            try await client.upload(botId: botId, id: id, name: file.name, data: file.data)
                            Self.cacheAttachment(id, file.data)
                            ids?.append(id)
                        }
                    }
                    return try await client.send(botId: botId, text: text, clientNonce: nonce, threadId: thread, attachments: ids)
                }
                outgoingFiles[nonce] = nil
                upsert(e)
                if let bot = bots[botId] { onSent?(bot) }
            } catch {
                if outgoingFiles[nonce] != nil { lastError = "Couldn't send the files: \(error.localizedDescription)" }
                markLocal(nonce: nonce, botId: botId, status: "failed")
            }
        }
    }

    /// The computer is offline: the message waits, sealed for it, in the relay mailbox.
    private func enqueue(_ remote: any RemoteTransport, text: String, botId: String, thread: String?, nonce: String) {
        markLocal(nonce: nonce, botId: botId, status: "waiting")
        saveCache()
        Task {
            do {
                try await remote.enqueue(botId: botId, text: text, clientNonce: nonce, threadId: thread)
                if let bot = bots[botId] { onSent?(bot) }
            } catch MailboxError.hostOnline {
                // Presence can race the stream state. Wait for the host's events channel
                // before trying the normal API, instead of turning that race into a failure.
                markLocal(nonce: nonce, botId: botId, status: "sending")
                await deliverWhenOnline(text, botId: botId, thread: thread, nonce: nonce)
            } catch {
                // A dropped relay link: the message's own "Failed to send" and Resend say enough.
                if (error as? HostError)?.isTransient != true { lastError = error.localizedDescription }
                markLocal(nonce: nonce, botId: botId, status: "failed")
            }
            saveCache()
        }
    }

    private func deliverWhenOnline(_ text: String, botId: String, thread: String?, nonce: String) async {
        let deadline = ContinuousClock.now + .seconds(30)
        while !retired, connection != .online, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard !retired else { return }
        guard connection == .online else {
            lastError = "The computer came online, but the message couldn't be sent. Retry it when the connection is ready."
            markLocal(nonce: nonce, botId: botId, status: "failed")
            saveCache()
            return
        }
        deliver(text, botId: botId, thread: thread, nonce: nonce)
    }

    /// Takes a waiting message back out of the mailbox, unless the computer already has it.
    public func cancelQueued(_ entry: Entry) {
        guard let nonce = entry.data.clientNonce, let remote = transport as? any RemoteTransport else { return }
        Task {
            switch await remote.cancelQueued(clientNonce: nonce) {
            case .cancelled:
                discard(entry)
            case .delivering:
                markLocal(nonce: nonce, botId: entry.botId, status: "delivering")
            case .unknown:
                lastError = "Couldn't take the message back. It may have been delivered already."
            }
            saveCache()
        }
    }

    private func applyMailbox(_ event: MailboxEvent) {
        guard let entry = entries.values.lazy.flatMap({ $0 }).first(where: { $0.id == "local-\(event.nonce)" }) else { return }
        switch event {
        // The events stream's own copy replaces it (matched by clientNonce).
        case .delivered: markLocal(nonce: event.nonce, botId: entry.botId, status: "delivering")
        case .failed, .expired: markLocal(nonce: event.nonce, botId: entry.botId, status: "failed")
        }
        saveCache()
    }

    /// Messages the relay no longer holds were delivered, refused or expired while we were away.
    /// "Failed" is safe even if one was delivered: the events catch-up replaces it by clientNonce,
    /// and a resend reuses that nonce, so the computer never runs it twice.
    private func reconcileQueued(_ remote: any RemoteTransport) async {
        let waiting = entries.values.flatMap { $0 }.filter { $0.data.status == "waiting" }
        guard !waiting.isEmpty else { return }
        let heldItems: [QueuedItem]
        do {
            heldItems = try await remote.listQueued()
        } catch {
            log.debug("mailbox reconciliation deferred: \(error.localizedDescription)")
            return
        }
        let held = Dictionary(heldItems.map { ($0.nonce, $0.state) }, uniquingKeysWith: { a, _ in a })
        guard !retired else { return }
        for e in waiting {
            guard let nonce = e.data.clientNonce else { continue }
            switch held[nonce] {
            case "queued": break
            case .some: markLocal(nonce: nonce, botId: e.botId, status: "delivering")
            case nil: markLocal(nonce: nonce, botId: e.botId, status: "failed")
            }
        }
        saveCache()
    }

    public func retry(_ entry: Entry) {
        let files = entry.data.clientNonce.flatMap { outgoingFiles[$0] } ?? []
        guard let text = entry.data.text, !text.isEmpty || !files.isEmpty else { return }
        entries[entry.botId]?.removeAll { $0.id == entry.id }
        // The same clientNonce: if the computer got it after all, it won't run twice (the host
        // skips a nonce it has). Every seal still takes a fresh ephemeral key (§6.4).
        send(text, to: entry.botId, thread: entry.threadId, nonce: entry.data.clientNonce ?? UUID().uuidString, files: files)
    }

    /// A sent file's bytes: on disk after the first fetch (sent files never change).
    public func attachmentData(_ file: Attachment, bot botId: String) async -> Data? {
        guard let url = Self.attachmentCache(file.id) else { return nil }
        if let data = try? Data(contentsOf: url) { return data }
        guard let client = live, let data = try? await client.readUpload(botId: botId, id: file.id) else { return nil }
        Self.cacheAttachment(file.id, data)
        return data
    }

    private static func attachmentCache(_ id: String) -> URL? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        return URL.cachesDirectory.appending(path: "codync-attachments").appending(path: uuid.uuidString)
    }

    private static func cacheAttachment(_ id: String, _ data: Data) {
        guard let url = attachmentCache(id) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url)
    }

    public func discard(_ entry: Entry) {
        if let nonce = entry.data.clientNonce { outgoingFiles[nonce] = nil }
        entries[entry.botId]?.removeAll { $0.id == entry.id }
        scheduleSave()
    }

    private func markLocal(nonce: String, botId: String, status: String) {
        guard var list = entries[botId], let i = list.firstIndex(where: { $0.id == "local-\(nonce)" }) else { return }
        list[i].data.status = status
        entries[botId] = list
        scheduleSave()
    }

    public func stop(_ botId: String) { perform(replay: true) { try await $0.stop(botId) } }
    public func logCall(_ botId: String, seconds: Int) { perform { try await $0.logCall(botId, seconds: seconds) } }
    public func newSession(_ botId: String) { perform { try await $0.newSession(botId) } }

    // MARK: remote screen

    /// Takes control from bots (they can still look) or hands it back.
    public func screenTakeover(_ on: Bool) {
        perform(replay: true) { [weak self] in self?.screen = try await $0.screenTakeover(on) }
    }

    /// Only the computer itself may turn remote screen on (the Mac menu).
    public func setScreenEnabled(_ on: Bool) async throws {
        screen = try await ready().setScreenEnabled(on)
    }

    /// Quick reactions offered on every message (Slack's hover bar).
    public static let quickReactions = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

    /// Toggles the user's reaction; shown at once, then replaced by the host's copy.
    public func react(_ entry: Entry, _ emoji: String) {
        guard let i = entries[entry.botId]?.firstIndex(where: { $0.id == entry.id }) else { return }
        var reactions = entries[entry.botId]?[i].data.reactions ?? []
        if let at = reactions.firstIndex(of: emoji) { reactions.remove(at: at) } else { reactions.append(emoji) }
        entries[entry.botId]?[i].data.reactions = reactions
        perform { client in
            let e = try await client.react(entryId: entry.id, emoji: emoji)
            self.upsert(e)
        }
    }

    /// Permission cards whose answer is on its way, with the chosen option: the card shows
    /// a spinner on it and takes no second answer.
    public private(set) var answering: [String: String] = [:]

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

    @ObservationIgnored private var readingViews: [UUID: ReadingScope] = [:]

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

    private func acknowledgeVisibleConversations(_ botId: String, entry: Entry? = nil) {
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

    public func setPinned(_ bot: Bot, _ pinned: Bool) {
        var d = BotDraft(bot)
        d.pinned = pinned
        bots[bot.id]?.pinned = pinned
        perform(replay: true) { _ = try await $0.updateBot(d) }
    }

    public func setHidden(_ bot: Bot, _ hidden: Bool) {
        var d = BotDraft(bot)
        d.hidden = hidden
        bots[bot.id]?.hidden = hidden
        perform(replay: true) { _ = try await $0.updateBot(d) }
    }

    public func delete(_ bot: Bot) {
        bots[bot.id] = nil
        entries[bot.id] = nil
        perform(replay: true) { try await $0.deleteBot(bot.id) }
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
        guard let client, let replies = try? await client.thread(botId: botId, rootId: root) else { return }
        for e in replies { upsert(e) }
    }

    public func save(_ draft: BotDraft) async throws -> Bot {
        let client = try await ready()
        let bot = draft.id == nil ? try await client.createBot(draft) : try await client.updateBot(draft)
        bots[bot.id] = bot
        return bot
    }

    // MARK: plugins

    public func refreshPlugins() async {
        guard let client else { return }
        async let c = client.connectors()
        async let s = client.skills()
        if let c = try? await c { installedConnectors = c }
        if let s = try? await s { installedSkills = s }
    }

    public func marketConnectors(search: String, cursor: String? = nil) async throws -> (items: [MarketConnector], next: String?) {
        try await ready().marketConnectors(search: search, cursor: cursor)
    }

    public func marketSkills() async throws -> [MarketSkill] {
        try await ready().marketSkills()
    }

    @discardableResult
    public func installConnector(_ item: MarketConnector, option: String, inputs: [String: String]) async throws -> InstalledConnector {
        let c = try await ready().installConnector(registryName: item.name, option: option, inputs: inputs)
        await refreshPlugins()
        return c
    }

    @discardableResult
    public func addConnector(name: String, command: String?, url: String?, env: [String: String], headers: [String: String]) async throws -> InstalledConnector {
        let c = try await ready().addConnector(name: name, command: command, url: url, env: env, headers: headers)
        await refreshPlugins()
        return c
    }

    public func importConnectors(config: String) async throws -> [InstalledConnector] {
        let added = try await ready().importConnectors(config: config)
        await refreshPlugins()
        return added
    }

    public func connectorSignIn(_ id: String) async throws -> ConnectorSignIn {
        try await ready().connectorSignIn(id)
    }

    public func finishConnectorSignIn(state: String, code: String?, error: String?) async throws {
        try await ready().finishConnectorSignIn(state: state, code: code, error: error)
        await refreshPlugins()
    }

    /// Waits while the user signs in in the computer's browser (the host catches the return).
    public func waitForSignIn(_ id: String) async throws {
        for _ in 0..<150 {
            try await Task.sleep(for: .seconds(2))
            await refreshPlugins()
            if installedConnectors.first(where: { $0.id == id })?.needsSignIn == false { return }
        }
    }

    public func removeConnector(_ id: String) async throws {
        try await ready().removeConnector(id)
        await refreshPlugins()
    }

    public func installSkill(source: String) async throws {
        try await ready().installSkill(source: source)
        await refreshPlugins()
    }

    public func addSkill(name: String, description: String, instructions: String) async throws {
        try await ready().addSkill(name: name, description: description, instructions: instructions)
        await refreshPlugins()
    }

    public func removeSkill(_ id: String) async throws {
        try await ready().removeSkill(id)
        await refreshPlugins()
    }

    /// Re-detects agents on the computer (after an install or sign-in).
    public func refreshBackends() async {
        guard let client, let backends = try? await client.refreshBackends() else { return }
        hello?.backends = backends
    }

    public func listDirs(_ path: String?) async throws -> DirListing {
        try await ready().listDirs(path)
    }

    public func refreshUsage() async {
        guard !retired, let client else { return }
        if let u = try? await client.usage(refresh: true), !Task.isCancelled { setUsage(u) }
    }

    public func loadOlder(_ botId: String) async {
        guard let client, !historyComplete.contains(botId) else { return }
        let first = chat(botId).first { $0.seq > 0 && $0.seq != Int64.max }?.seq ?? Int64.max
        guard let older = try? await client.history(botId: botId, beforeSeq: first, limit: 100) else { return }
        if older.count < 100 { historyComplete.insert(botId) }
        for e in older { upsert(e) }
    }

    /// Fire-and-forget actions; only what waiting and retrying couldn't settle reaches the dialog.
    private func perform(replay: Bool = false, _ op: @escaping @MainActor (HostClient) async throws -> Void) {
        Task {
            do {
                try await withLink(replay: replay, op)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    // MARK: cache (instant launch, offline reading)

    private struct Cache: Codable {
        /// App build + host version that wrote the cache; any change means refetch everything.
        var stamp: String?
        var hostId: String?
        var rev: Int64
        var bots: [Bot]
        var entries: [Entry]
    }

    private static let appBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    private var cacheStamp: String?

    /// Per app, context and computer (`SharedStore.Context.erase()` removes a context's files).
    private var cacheURL: URL {
        URL.cachesDirectory.appending(path: "codync-mirror-\(Bundle.main.bundleIdentifier ?? "app")-\(storage.id)-\(computer.id).json")
    }

    private func loadCache() {
        // A cache from another app build still shows at once; the stamp mismatch makes the next
        // hello fetch everything again underneath it.
        guard let data = try? Data(contentsOf: cacheURL),
              let cache = try? JSONDecoder().decode(Cache.self, from: data) else { return }
        cacheStamp = cache.stamp ?? ""
        hostId = cache.hostId
        rev = cache.rev
        bots = Dictionary(cache.bots.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        entries = Dictionary(grouping: cache.entries, by: \.botId)
    }

    private func scheduleSave() {
        guard !retired else { return }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { saveCache() }
        }
    }

    public func saveCache() {
        guard !retired else { return }
        // Keep the newest 200 entries per bot; older ones page in from the host. Local queued and
        // failed messages stay visible so they can be cancelled or retried after a relaunch.
        let kept = entries.values.flatMap { list in
            list.filter { !$0.id.hasPrefix("local-") }.suffix(200)
                + list.filter { $0.id.hasPrefix("local-") && ["waiting", "delivering", "failed"].contains($0.data.status) }
        }
        let cache = Cache(stamp: "\(Self.appBuild)/\(hello?.version ?? "")", hostId: hostId, rev: rev, bots: Array(bots.values), entries: kept)
        if let data = try? JSONEncoder().encode(cache) {
            try? data.write(to: cacheURL, options: .atomic)
        }
    }
}

/// A file picked in the composer, sent with the next message.
public struct OutgoingFile: Identifiable, Sendable {
    public let id = UUID()
    public let name: String
    public let data: Data

    public init(name: String, data: Data) {
        self.name = name
        self.data = data
    }

    /// Anything larger is refused by the computer.
    public static let maxSize = 100 * 1024 * 1024
}
