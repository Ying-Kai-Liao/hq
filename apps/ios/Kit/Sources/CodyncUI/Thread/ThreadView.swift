import CodyncKit
import SwiftUI

/// One endless conversation with a bot or a group chat. Only deliberate messages show
/// here; tool calls and thinking live in the "Full conversation" sheet. Any message can
/// start a thread, which opens beside the chat (Mac) or over it (iPhone).
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
    /// Desktop: the bot's settings as an inspector beside the chat.
    @State var showSettings = true
    @State var editingDetails = false
    @State var availableWidth: CGFloat = 800
    @State var compactDetails = false
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

    public var body: some View { platformBody }

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
        platformChrome(chat)
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
                .appFont(.footnote)
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
                        .appFont(.footnote).foregroundStyle(Palette.secondary).padding(.vertical, 10)
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
                    Image(systemName: connectionSymbol).appFont(.system(size: 8, weight: .medium))
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)
            Text(model.connectionLabel)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .appFont(.system(size: 10, weight: .medium))
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
        case .loopback: return "desktopcomputer"
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
        case .loopback: return "Connected locally"
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
                .appFont(.system(size: InterfaceMetrics.value(mac: 14, mobile: 13), weight: .semibold))
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

    var textContent: String? {
        if case let .entry(entry, _) = kind { entry.data.text } else { nil }
    }
}

/// The start of an empty group chat: who's in it and how the room works.
struct GroupIntroCard: View {
    let group: Bot
    @Environment(BotStore.self) private var model

    var body: some View {
        VStack(spacing: 12) {
            GroupAvatar(members: model.members(of: group), size: 72)
            Text(group.name).appFont(.title2.weight(.semibold)).foregroundStyle(Palette.text)
            Text(model.members(of: group).map(\.name).joined(separator: " · "))
                .appFont(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
            if !group.description.isEmpty {
                Text(group.description)
                    .appFont(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Everyone answers in turn. @mention a bot to ask just that one. Each bot works in its own folder.")
                .appFont(.footnote)
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
            Text(bot.name).appFont(.title2.weight(.semibold)).foregroundStyle(Palette.text)
            Text(bot.managedWorkspace ? "\(model.backendName(bot.backend)) · Personal workspace" : "\(model.backendName(bot.backend)) in \(bot.cwd)")
                .appFont(.footnote.monospaced())
                .foregroundStyle(Palette.tertiary)
                .multilineTextAlignment(.center)
            if !bot.description.isEmpty {
                Text(bot.description)
                    .appFont(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            Text("Tell it what you need. You'll get a notification when it's done or needs you.")
                .appFont(.footnote)
                .foregroundStyle(Palette.tertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

extension View {
    @ViewBuilder func conversationInitialBottomAnchor() -> some View {
        if #available(iOS 18, macOS 15, *) {
            defaultScrollAnchor(.bottom, for: .initialOffset)
        } else {
            defaultScrollAnchor(.bottom)
        }
    }

    @ViewBuilder func conversationBottomObserver(_ isAtBottom: Binding<Bool>) -> some View {
        if #available(iOS 18, macOS 15, *) {
            onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 48
            } action: { _, isAtBottomNow in
                isAtBottom.wrappedValue = isAtBottomNow
            }
        } else {
            self
        }
    }

    @ViewBuilder func conversationScrollEdges() -> some View {
        if #available(iOS 26, macOS 26, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }
}

