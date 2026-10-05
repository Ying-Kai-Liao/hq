import CodyncKit
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
    @State var editingGroup = false
    @State var editing: EditorRequest?
    @State var templateRequest: EditorRequest?
    @State var confirmNewSession = false
    @State var confirmDelete: Bot?
    @State var calling = false
    @State var callSpeaking = false
    @State var interruptCall: (() -> Void)?
    @State var showRoutines = false
    @State var routineId: String?
    @State var routineRequest = UUID()
        /// iPhone: the chat stays on the newest message until the reader scrolls away.
        @State var following = true
        /// The oldest message rendered (nil: the latest page).
        @State var firstShown: String?
        @State var loadingEarlier = false
        /// Earlier messages are going in above: this one keeps its place on screen.
        @State var keepingPlace: String?
        /// The top of the rendered messages is within reach.
        @State var topVisible = false
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
                    Composer(botId: botId,
                             onCall: !calling && bot?.isGroup == false ? { calling = true } : nil,
                             onInterrupt: callSpeaking ? interruptCall : nil)
                }
            }
            .animation(Motion.reduced(Motion.layout, reduceMotion), value: model.mismatch)
        }
        // Grok Bot's call: a bar floating over the chat, which stays readable and usable.
        .overlay(alignment: .top) {
            if calling {
                CallView(botId: botId, isSpeaking: $callSpeaking, interrupt: $interruptCall) {
                    withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { calling = false }
                }
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(Motion.reduced(Motion.layout, reduceMotion), value: calling)
    }

    var conversation: some View {
        chrome(chat)
            .readingConversation(botId)
            .codyncSheet(isPresented: $showTrace) {
                TraceView(botId: botId)
            }
            .codyncSheet(item: $templateRequest) { request in
                BotTemplateView(draft: request.draft)
            }
            .codyncSheet(item: $editing) { request in
                BotEditorView(draft: request.draft)
            }
            .codyncSheet(isPresented: $editingGroup) {
                GroupEditorView(group: bot)
            }
            .codyncDialog("Start a new session?", isPresented: $confirmNewSession,
                          message: "The conversation stays here, but the agent starts with a fresh context.") {
                [DialogAction("New session") { model.newSession(botId) }]
            }
            .codyncSheet(isPresented: $showRoutines) {
                ScrollView {
                    RoutinesView(botId: botId, initialId: routineId) {
                        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { showRoutines = false }
                    }.padding(20)
                }
            }
            .deleteBotConfirmation($confirmDelete) { dismiss() }
    }

    // MARK: rows

    @ViewBuilder func row(_ item: ChatItem) -> some View {
        switch item.kind {
        case .separator(let date):
            Text(RelativeTime.separator(date))
                .font(.footnote)
                .foregroundStyle(Palette.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.top, 18)
                .padding(.bottom, 6)
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
        }
    }

    func openRoutine(_ id: String?) {
        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) {
            routineId = id
            routineRequest = UUID()
            presentRoutine()
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
            items.append(MenuItem("Edit profile", icon: "pencil") {
                editProfile(bot)
            })
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
    }

    let id: String
    let kind: Kind

    /// Chat-visible entries plus time separators (gaps > 1 h) and author grouping.
    /// `streaming`: a turn is running in this chat, so the text being generated right now
    /// (the lane's last entry, still `final == false`) shows in place and never pops in later.
    /// Earlier segments of the turn, tool calls in between, and a room pass stay trace-only.
    /// `steady` (iPhone): the turn's newest text stays while the agent works on (tools,
    /// thinking) until newer text replaces it, and a reply is one item per author and turn,
    /// from its first words to the final message, so its bubble never pops out and back in.
    static func build(_ entries: [Entry], streaming: Bool = false, steady: Bool = false) -> [ChatItem] {
        var out: [ChatItem] = []
        var used = Set<String>()
        var lastDate: Date?
        var lastAuthor: String?
        let live = !streaming ? nil
            : steady ? liveText(entries)
            : entries.last.flatMap { $0.kind == "agent" && $0.data.final == false ? $0.id : nil }
        for e in entries where e.isChat || (e.id == live && !(e.data.text ?? "").isEmpty && e.data.text != "(pass)") {
            let date = e.date
            var id = e.kind == "user" ? e.data.clientNonce.map { "user-\($0)" } ?? e.id : e.id
            if steady, e.kind == "agent", !used.contains("reply-\(e.data.author ?? "")-\(e.turn)") {
                id = "reply-\(e.data.author ?? "")-\(e.turn)"
            }
            used.insert(id)
            if lastDate.map({ date.timeIntervalSince($0) > 3600 }) ?? true {
                out.append(ChatItem(id: "sep-\(id)", kind: .separator(date)))
                lastAuthor = nil
            }
            // In a group each bot is its own author.
            let author = e.kind == "user" ? "user" : e.kind == "agent" ? "agent:\(e.data.author ?? "")" : e.kind
            out.append(ChatItem(id: id, kind: .entry(e, groupStart: author != lastAuthor)))
            lastAuthor = (author == "user" || e.kind == "agent") ? author : nil
            lastDate = date
        }
        return out
    }

    /// The running turn's newest text, if any since the last message or final reply.
    static func liveText(_ entries: [Entry]) -> String? {
        for e in entries.reversed() {
            if e.kind == "user" || (e.kind == "agent" && e.data.final == true) { return nil }
            if e.kind == "agent", let text = e.data.text, !text.isEmpty {
                return text == "(pass)" ? nil : e.id
            }
        }
        return nil
    }

    var isUserMessage: Bool {
        if case let .entry(entry, _) = kind { entry.kind == "user" } else { false }
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
            Text(model.members(of: group).map(\.name).joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
            if !group.description.isEmpty {
                Text(group.description)
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Everyone answers in turn. @mention a bot to ask just that one. Each bot works in its own folder.")
                .font(.footnote)
                .foregroundStyle(Palette.tertiary)
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
                .font(.footnote.monospaced())
                .foregroundStyle(Palette.tertiary)
                .multilineTextAlignment(.center)
            if !bot.description.isEmpty {
                Text(bot.description)
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Tell it what you need. You'll get a notification when it's done or needs you.")
                .font(.footnote)
                .foregroundStyle(Palette.tertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

extension View {

    @ViewBuilder func conversationScrollEdges() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }
}

extension ThreadView {
    public var body: some View {
        conversation
            .codyncSheet(item: $openThread) { target in
                RepliesView(botId: botId, rootId: target.id) { closeThread() }
            }
    }

    /// Messages rendered per page, newest first.
    static let page = 40
    /// Paging needs to know when the reader nears the top (scroll geometry); before that, all render.
    static var paged: Bool {
        if #available(iOS 18, *) { true } else { false }
    }

    private var streaming: Bool { bot?.isWorking(in: botId, thread: nil) == true && !model.isOffline }

    /// iPhone's messages: the newest page first, earlier ones as the reader scrolls up (from
    /// this device, then from the computer); the chat follows the newest message until they
    /// scroll away, and a reply is revealed steadily as it's written.
    @ViewBuilder var transcript: some View {
        let thread = model.chat(botId)
        let all = ChatItem.build(thread, streaming: streaming, steady: true)
        let start = Self.paged ? firstShown.flatMap { id in all.firstIndex { $0.id == id } } ?? max(0, all.count - Self.page) : 0
        let items = Array(all[start...])
        let moreOnComputer = !model.historyComplete.contains(botId) && thread.count >= 50
        ScrollView {
            // Not lazy: only a page or a few render, and lazy rows of very different heights
            // (long replies) mis-estimate on the way to the bottom and can leave it blank.
            VStack(alignment: .leading, spacing: 0) {
                if start > 0 || moreOnComputer {
                    Spinner(size: 14)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .onChange(of: following) { _, _ in showEarlier() }
                        .accessibilityLabel("Loading earlier messages")
                }
                if all.isEmpty, let bot {
                    if bot.isGroup { GroupIntroCard(group: bot).padding(.top, 40) } else { IntroCard(bot: bot).padding(.top, 40) }
                }
                ForEach(items) { item in
                    row(item)
                        .id(item.id)
                        .transition(item.id == items.last?.id
                            ? .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)
                            : .identity)
                }
                // Offline, "working" is only what the computer last said; don't show it as live.
                if let bot, bot.isWorking(in: botId, thread: nil), !model.isOffline {
                    WorkingIndicator(bot: bot, thinking: model.currentThinking(botId, thread: nil))
                        .padding(.top, 6)
                        .id("working")
                        .transition(.opacity)
                }
                Color.clear.frame(height: 8).id("bottom")
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .animation(Motion.reduced(Motion.conversation, reduceMotion), value: items.last?.id)
            .animation(Motion.reduced(Motion.layout, reduceMotion), value: bot?.isWorking(in: botId, thread: nil))
        }
        .scrollIndicators(.never)
        .nearTop { near in
            topVisible = near
            showEarlier()
        }
        .followsConversation($following, keepingPlace: $keepingPlace)
        .scrollDismissesKeyboard(.interactively)
        .conversationScrollEdges()
        .simultaneousGesture(TapGesture().onEnded { dismissChatKeyboard() })
        .onChange(of: items.last?.id) { _, _ in
            // Sending brings the chat back down to your message.
            if items.last?.isUserMessage == true { following = true }
        }
        .overlay(alignment: .bottom) {
            JumpToLatest(visible: !following && !items.isEmpty) { following = true }
        }
        .onAppear { if firstShown == nil { firstShown = items.first?.id } }
    }

    /// The reader scrolled up to the top: render the previous page, fetching it from the
    /// computer when this device has no more. The message they were on keeps its place.
    private func showEarlier() {
        guard topVisible, !following, !loadingEarlier else { return }
        loadingEarlier = true
        Task {
            var list = ChatItem.build(model.chat(botId), streaming: streaming, steady: true)
            var start = firstShown.flatMap { id in list.firstIndex { $0.id == id } } ?? max(0, list.count - Self.page)
            if start == 0 {
                let anchor = list.first?.id
                await model.loadOlder(botId)
                list = ChatItem.build(model.chat(botId), streaming: streaming, steady: true)
                start = anchor.flatMap { id in list.firstIndex { $0.id == id } } ?? 0
            }
            guard start > 0 else {
                loadingEarlier = false
                return
            }
            keepingPlace = list[start].id
            firstShown = list[max(0, start - Self.page)].id
            // Rows above settle over a few layout passes.
            try? await Task.sleep(for: .milliseconds(400))
            keepingPlace = nil
            loadingEarlier = false
            // Still at the top with more to show: keep going.
            showEarlier()
        }
    }

    /// The system navigation bar: the title pill holds the bot's actions; the corner is the computer.
    func chrome(_ content: some View) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        header
                        connectionSubtitle
                    }
                }
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
        if bot?.isGroup == true { editingGroup = true } else if let bot { editing = EditorRequest(BotDraft(bot)) }
    }

    /// Opens the computer's screen; pulses while this bot is operating it (watch, then take over).
    private var computerButton: some View {
        let operating = model.screen?.agentBot == botId
        return Button("Computer", systemImage: "desktopcomputer") {
            model.screenRequest = operating ? ScreenRequest(watching: botId) : ScreenRequest()
        }
        .symbolEffect(.pulse, options: .repeating, isActive: operating)
    }

    func dismissChatKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    func presentRoutine() {
        showRoutines = true
    }

    func editProfile(_ bot: Bot) {
        editing = EditorRequest(BotDraft(bot))
    }
}
