import KithKit
import SwiftUI
import UIKit

/// One endless conversation with a bot or a group chat. Only deliberate messages show
/// here; tool calls and thinking live in the "Full conversation" sheet. Any message can
/// start a thread, which opens over it.
public struct ThreadView: View {
    let botId: String

    public init(botId: String) { self.botId = botId }
    @Environment(BotStore.self) var model
    @Environment(\.dismiss) var dismiss
    @State var showTrace = false
    @State var openThread: ThreadTarget?
    @State var botChat: BotChatTarget?
    @State var editingGroup = false
    @State var details: DetailsRequest?
    @State var confirmNewSession = false
    @State var confirmDelete: Bot?
    @State var calling = false
    /// The chat stays on the newest message until the reader scrolls away.
    @State var following = true
    @State var loadingEarlier = false
    /// Tasks the user opened or folded on this device; the rest follow their state.
    @State var taskChoices: [String: Bool] = [:]
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var bot: Bot? { model.bots[botId] }


    func closeThread() {
        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { openThread = nil }
    }

    /// The messages (each platform's own `transcript`, in its `ThreadView+` file) and the
    /// composer, without the platform's top chrome.
    private var chat: some View {
        transcript
        .background(Palette.background)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 6) {
                if let mismatch = model.mismatch {
                    // Nothing sent now could be read on the other side.
                    UpdateNeededCard(store: model, mismatch: mismatch)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .transition(.opacity)
                } else {
                    Composer(botId: botId, onCall: callBlock == nil ? { startCall() } : nil)
                }
            }
            .animation(Motion.reduced(Motion.layout, reduceMotion), value: model.mismatch)
        }
        // The call takes the whole screen; ending it, or leaving this chat, comes back here.
        .fullScreenCover(isPresented: $calling) {
            CallScreen(botId: botId) { calling = false }
        }
    }

    /// Why a call can't start now; nil when it can. The phone and header buttons show it.
    var callBlock: String? {
        if bot == nil { return "This chat is no longer available." }
        if model.isOffline { return "\(model.hostName) is offline." }
        if model.mismatch != nil { return "Update Kith to make calls." }
        return nil
    }

    /// One call at a time: a second tap while the screen is coming up does nothing.
    func startCall() {
        guard callBlock == nil, !calling else { return }
        calling = true
    }

    var conversation: some View {
        chrome(chat)
            .readingConversation(botId)
            .kithSheet(item: Binding<FileDownloads.Export?>(get: {
                guard let item = model.fileDownloads.export, item.botId == botId, item.threadId == nil else { return nil }
                return item
            }, set: { if $0 == nil { model.fileDownloads.dismissExport() } })) { item in
                FileExportSheet(url: item.url) { model.fileDownloads.dismissExport() }
            }
            .kithSheet(isPresented: $showTrace) {
                TraceView(botId: botId)
            }
            .kithSheet(item: $botChat) { BotConversationView(botId: botId, peerId: $0.id) }
            .kithSheet(item: $details) { request in
                BotDetailsView(botId: botId, request: request, call: CallAction(blocked: callBlock) {
                    // The call screen can only rise once the sheet is gone.
                    details = nil
                    Task {
                        try? await Task.sleep(for: .milliseconds(450))
                        startCall()
                    }
                })
            }
            .kithSheet(isPresented: $editingGroup) {
                GroupEditorView(group: bot)
            }
            .kithDialog("Start a new session?", isPresented: $confirmNewSession,
                          message: "The conversation stays here, but the agent starts with a fresh context.") {
                [DialogAction("New session") { model.newSession(botId) }]
            }
            .deleteBotConfirmation($confirmDelete) { dismiss() }
    }

    // MARK: rows

    @ViewBuilder func row(_ item: ChatItem) -> some View {
        switch item.kind {
        case .separator(let date):
            TimeSeparator(date: date)
        case .exchanges(let group):
            BotMessageRow(group: group) { botChat = BotChatTarget(id: group.peerId) }
        case .task(let root):
            if let bot {
                TaskRow(root: root, bot: bot, newest: root.id == Tasks.current(in: model.chat(botId))?.id,
                        choice: Binding(get: { taskChoices[root.id] }, set: { taskChoices[root.id] = $0 })) {
                    showTrace = true
                } openThread: {
                    withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { openThread = ThreadTarget(id: root.id) }
                }
            } else {
                // Without its bot (deleted) a task is just its first message.
                ChatRow(entry: root, groupStart: true, chat: bot) { showTrace = true }
            }
        case .entry(let e, let groupStart):
            if e.kind == "notice", let id = e.data.routineId {
                Button {
                    openRoutine(id)
                } label: {
                    Label(e.data.text ?? "Routine", systemImage: "clock.arrow.circlepath")
                        .font(.footnote).foregroundStyle(Palette.secondary).padding(.vertical, 10)
                }.buttonStyle(.plain)
            } else {
                ChatRow(entry: e, groupStart: groupStart, chat: bot) {
                    showTrace = true
                } openThread: { root in
                    withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { openThread = ThreadTarget(id: root.id) }
                }
                    .equatable()
            }
        }
    }

    // MARK: chrome

    var connectionSubtitle: some View {
        HStack(spacing: 6) {
            Group {
                if model.shownConnection == .connecting {
                    Spinner(size: 8)
                } else {
                    Image(systemName: connectionSymbol).font(.system(size: 8, weight: .medium))
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)
            Text(model.connectionLabel)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(Palette.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(model.hostName), \(connectionDescription)")
        .help("\(model.hostName) · \(connectionDescription)")
    }

    private var connectionSymbol: String {
        guard model.connection == .online else { return "wifi.slash" }
        switch model.hostRoute {
        case .relay: return "cloud"
        case .direct: return "wifi"
        case nil: return "network"
        }
    }

    private var connectionDescription: String {
        switch model.shownConnection {
        case .connecting: return "Connecting"
        case .computerOffline, .offline: return "Offline"
        case .unauthorized: return "No access"
        case .unpaired: return "Not paired"
        case .online: break
        }
        if model.mismatch != nil { return "Needs update" }
        switch model.hostRoute {
        case .relay: return "Connected through Cloudflare"
        case .direct: return "Connected over Wi-Fi or Tailscale"
        case nil: return "Connected"
        }
    }

    var title: some View {
        HStack(spacing: 7) {
            if let bot {
                let size: CGFloat = 22
                if bot.isGroup { GroupAvatar(members: model.members(of: bot), size: size) } else { CharacterAvatar(bot: bot, size: size) }
            }
            Text(bot?.name ?? "")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    func openRoutine(_ id: String?) {
        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) {
            details = DetailsRequest(tab: .details, routineId: id)
        }
    }

    var menuItems: [MenuItem] {
        var items = [MenuItem("Full conversation", icon: "list.bullet.rectangle") { showTrace = true }]
        if let bot, bot.isGroup {
            items.append(MenuItem("Edit group", icon: "person.2") { editingGroup = true })
            items.append(MenuItem(bot.pinned ? "Unpin" : "Pin", icon: "pin") { model.setPinned(bot, !bot.pinned) })
            items.append(MenuItem("Delete group", icon: "trash", destructive: true, divider: true) { confirmDelete = bot })
            return items
        }
        if let bot {
            items.append(MenuItem("Settings", icon: "gearshape") { openSettings() })
            items.append(MenuItem(bot.pinned ? "Unpin" : "Pin", icon: "pin") { model.setPinned(bot, !bot.pinned) })
        }
        items.append(MenuItem("Routines", icon: "clock.arrow.circlepath") {
            openRoutine(nil)
        })
        items.append(MenuItem("New session", icon: "arrow.counterclockwise") { confirmNewSession = true })
        items.append(MenuItem("Delete bot", icon: "trash", destructive: true, divider: true) { confirmDelete = bot })
        return items
    }
}

// MARK: - Chat model

struct ChatItem: Identifiable {
    enum Kind {
        case separator(Date)
        case entry(Entry, groupStart: Bool)
        /// Main chat only: consecutive bot-to-bot exchanges with one peer.
        case exchanges(BotExchangeGroup)
        /// Main chat only: a task's first message, shown with its thread or as a card (`TaskRow`).
        case task(Entry)
    }

    let id: String
    let kind: Kind

    /// Chat-visible entries plus time separators (gaps > 1 h) and author grouping. A bot's
    /// messages arrive whole (Grok Bot's `send_message`); what it writes along the way is trace.
    static func build(_ entries: [Entry], groupingExchanges: Bool = false) -> [ChatItem] {
        var out: [ChatItem] = []
        var lastDate: Date?
        var lastAuthor: String?
        let slots = groupingExchanges ? BotExchangeGroup.collapse(entries) : entries.filter(\.isChat).map(BotExchangeGroup.Item.entry)
        for slot in slots {
            let date = slot.date
            // Bot-originated messages carry an empty nonce. Their entry IDs
            // distinguish them; only real nonces identify optimistic echoes.
            let id = if case .entry(let e) = slot, e.kind == "user", let nonce = e.data.clientNonce, !nonce.isEmpty { "user-\(nonce)" } else { slot.id }
            if lastDate.map({ date.timeIntervalSince($0) > 3600 }) ?? true {
                out.append(ChatItem(id: "sep-\(id)", kind: .separator(date)))
                lastAuthor = nil
            }
            lastDate = date
            switch slot {
            case .exchanges(let group):
                out.append(ChatItem(id: id, kind: .exchanges(group)))
                lastAuthor = nil
            case .entry(let e) where groupingExchanges && e.isTask:
                out.append(ChatItem(id: id, kind: .task(e)))
                lastAuthor = nil
            case .entry(let e):
                // In a group each bot is its own author.
                let author = e.kind == "user" ? "user" : e.kind == "agent" ? "agent:\(e.data.author ?? "")" : e.kind
                out.append(ChatItem(id: id, kind: .entry(e, groupStart: author != lastAuthor)))
                lastAuthor = (author == "user" || e.kind == "agent") ? author : nil
            }
        }
        return out
    }

    var isUserMessage: Bool {
        switch kind {
        case let .entry(entry, _): entry.kind == "user"
        case .task: true
        default: false
        }
    }

}

/// The start of an empty group chat: who's in it and how the room works.
struct GroupIntroCard: View {
    let group: Bot
    @Environment(BotStore.self) private var model

    var body: some View {
        VStack(spacing: 12) {
            GroupAvatar(members: model.members(of: group), size: 72)
            Text(group.name).font(.title2.weight(.semibold)).foregroundStyle(Palette.text)
            let names = model.members(of: group).map(\.name)
            if group.name != names.joined(separator: ", ") {
                Text(names.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            if !group.description.isEmpty {
                Text(group.description)
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Everyone answers in turn. @mention a bot to ask just that one.")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

struct IntroCard: View {
    let bot: Bot
    @Environment(BotStore.self) private var model

    var body: some View {
        VStack(spacing: 12) {
            CharacterAvatar(bot: bot, size: 72)
            Text(bot.name).font(.title2.weight(.semibold)).foregroundStyle(Palette.text)
            Text(bot.managedWorkspace ? "\(model.backendName(bot.backend)) · Personal workspace" : "\(model.backendName(bot.backend)) in \(bot.cwd)")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
            if !bot.description.isEmpty {
                Text(bot.description)
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Tell it what you need. You'll get a notification when it's done or needs you.")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

extension ThreadView {
    public var body: some View {
        conversation
            .kithSheet(item: $openThread) { target in
                RepliesView(botId: botId, rootId: target.id) { closeThread() }
            }
    }

    private var working: Bool { bot?.isWorking(in: botId, thread: nil) == true && !model.isOffline }

    /// iPhone's messages: all this device has, earlier ones from the computer as the reader
    /// scrolls up; the chat follows the newest message until they scroll away, and a reply is
    /// revealed steadily as it's written.
    var transcript: some View {
        let thread = model.chat(botId)
        let items = ChatItem.build(thread, groupingExchanges: true)
        var rows: [ConversationRow] = []
        if moreOnComputer {
            rows.append(ConversationRow("earlier") {
                Spinner(size: 14)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .accessibilityLabel("Loading earlier messages")
                    // A chat shorter than the screen never scrolls, so showing the row is the trigger.
                    .onAppear { showEarlier() }
            })
        }
        if items.isEmpty, let bot {
            rows.append(ConversationRow("intro") {
                if bot.isGroup { GroupIntroCard(group: bot).padding(.top, 40) } else { IntroCard(bot: bot).padding(.top, 40) }
            })
        }
        rows += items.map { item in ConversationRow(item.id, isUserMessage: item.isUserMessage) { row(item) } }
        // Offline, "working" is only what the computer last said; don't show it as live.
        if let bot, working {
            rows.append(ConversationRow("working") {
                WorkingIndicator(bot: bot, thinking: model.currentThinking(botId, thread: nil))
                    .padding(.top, 6)
            })
        }
        // Pull to refresh reconnects, like Reconnect in the computer menu, until the link is back.
        return ConversationList(rows: rows, following: $following, nearTop: { showEarlier() }, refresh: {
            model.restartStream()
            _ = try? await model.ready()
        })
    }

    private var moreOnComputer: Bool {
        model.canLoadOlder(botId)
    }

    /// The reader scrolled up to the top: fetch earlier messages from the computer.
    private func showEarlier() {
        guard moreOnComputer, !loadingEarlier else { return }
        loadingEarlier = true
        Task {
            await model.loadOlder(botId)
            loadingEarlier = false
        }
    }

    /// The system navigation bar: the title pill holds the bot's actions; the corner is the computer.
    func chrome(_ content: some View) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            // The folder chip gets its own row under the bar: stacked into the title it left the name
            // and the status a sliver of height and the path no width.
            .safeAreaInset(edge: .top, spacing: 0) {
                if bot?.isGroup != true, model.placeFolder(botId, thread: nil) != nil {
                    PlaceFolderChip(botId: botId)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 4)
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        header
                        connectionSubtitle
                    }
                    .layoutPriority(1)
                }
                ToolbarItem(placement: .topBarTrailing) { callButton }
                if model.screen != nil {
                    ToolbarItem(placement: .topBarTrailing) { computerButton }
                }
            }
    }

    var header: some View {
        // Like Grok Bot: the title pill holds the bot's actions; the corner is the computer.
        Menu {
            Text("\(model.hostName) · \(model.connectionLabel)")
            Button("Reconnect", systemImage: "arrow.clockwise") { model.restartStream() }
            Divider()
            Button("Details", systemImage: "info.circle", action: openDetails)
            ForEach(menuItems) { item in
                if item.divider { Divider() }
                Button(role: item.destructive ? .destructive : nil, action: item.action) {
                    if let icon = item.icon { Label(item.title, systemImage: icon) } else { Text(item.title) }
                }
            }
        } label: {
            title
        }
        .accessibilityLabel("\(bot?.name ?? "Conversation") actions")
    }

    private func openDetails() {
        if bot?.isGroup == true { editingGroup = true } else { details = DetailsRequest() }
    }

    /// Starts a voice call; disabled, with the reason as its hint, when none can start.
    private var callButton: some View {
        Button("Call", systemImage: "phone.fill", action: startCall)
            .disabled(callBlock != nil || calling)
            .accessibilityHint(callBlock ?? "")
            .help(callBlock ?? "Call \(bot?.name ?? "")")
    }

    /// Opens the computer's screen; pulses while this bot is operating it (watch, then take over).
    private var computerButton: some View {
        let operating = model.screen?.agentBot == botId
        return Button("Computer", systemImage: "desktopcomputer") {
            model.screenRequest = operating ? ScreenRequest(watching: botId) : ScreenRequest()
        }
        .symbolEffect(.pulse, options: .repeating, isActive: operating)
    }

    func openSettings() {
        details = DetailsRequest(tab: .settings)
    }
}
