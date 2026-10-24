import KithKit
import KithUI
import SwiftUI

/// Every computer this iPhone can use or ask for — paired here and in the account, merged by
/// computer ID — plus settings for the selected account.
struct SettingsView: View {
    /// Pushed inside Accounts rather than opened as its own sheet.
    var pushed = false
    /// Which half of the screen shows: the profile menu opens Computers and Settings apart, the Account sheet both.
    enum Mode { case all, computers, settings }
    var mode = Mode.all
    @Environment(AppStore.self) private var app
    @Environment(AccountStore.self) private var accounts
    @Environment(\.dismissModal) private var dismissModal
    @Environment(\.openURL) private var openURL
    @State private var notificationsAllowed: Bool?
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true
    @AppStorage(Analytics.enabledKey) private var analyticsEnabled = true
    @AppStorage(TextSizePreference.key) private var textSize = TextSizePreference.system.rawValue
    @AppStorage(AppearancePreference.key) private var appearance = AppearancePreference.system.rawValue
    @State private var addingComputer = false
    @State private var confirmForget: Computer?
    @State private var confirmRevoke: CloudComputer?
    @State private var access: AccessTarget?
    @State private var confirmStartOver = false
    @State private var confirmRemoveCopy: CloudComputer?
    @State private var aboutAnalytics = false
    @State private var showLicenses = false
    @State private var newChat: VoiceTarget?
    @AppStorage(CrewOrderMode.storageKey) private var crewOrder = CrewOrderMode.automatic.rawValue
    @AppStorage("hiddenComputers") private var hiddenComputers = ""
    @State private var widgets = false
    @State private var showAccount = false
    /// The computer whose page is pushed (computer ID), and the one whose Voice chat page is.
    @State private var computerPage: ComputerID?
    @State private var voicePage: ComputerID?

    private var showsComputers: Bool { mode != .settings }
    private var showsSettings: Bool { mode != .computers }
    private var title: String { mode == .computers ? "Computers" : mode == .settings ? "Settings" : "Computers & settings" }

    var body: some View {
        CardForm {
            if !pushed { AccountCard { showAccount = true } }

            if showsComputers {
            let selection = ComputerSelection(all: accounts.computers.map(\.id), hidden: hiddenComputers)
            CardSection("Computers", footer: app.account.isSignedIn
                        ? "Computers in your account need your OK on the computer before this iPhone can use them."
                        : "Each bot runs on its own computer. Sign in to see the computers in your account.") {
                ForEach(accounts.computers) { computer in
                    let shown = Binding(get: { selection.shown.contains(computer.id) },
                                        set: { _ in withAnimation(Motion.layout) { hiddenComputers = selection.toggling(computer.id) } })
                    if let store = accounts.store(for: computer.id), accounts.role(for: computer.id) == .member {
                        MemberComputerRow(store: store, shown: shown, newChat: { newChat = VoiceTarget(store: store) }, remove: { confirmForget = computer })
                    } else if let store = accounts.store(for: computer.id) {
                        ComputerRow(store: store, shown: shown, open: { computerPage = computer.id },
                                    openScreen: { openScreen(store) },
                                    openMarketplace: { closeSheets { app.marketplace = store.computer.id } },
                                    openVoice: { voicePage = computer.id },
                                    revoke: cloudComputer(computer.id).flatMap { c in c.access == "granted" ? { confirmRevoke = c } : nil },
                                    remove: { confirmForget = computer })
                    }
                }
                ForEach(accountOnly) { computer in
                    if accounts.isOlderCopy(computer) {
                        OlderCopyRow(computer: computer) { confirmRemoveCopy = computer }
                    } else {
                        AccountComputerRow(computer: computer, ticket: accounts.pendingAccess[computer.computerId],
                                           ask: { access = AccessTarget(computer: computer) },
                                           revoke: { confirmRevoke = computer })
                    }
                }
                Button {
                    addingComputer = true
                } label: {
                    Label("Pair a computer", systemImage: "qrcode")
                        .foregroundStyle(Palette.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } accessory: {
                if !accounts.computers.isEmpty {
                    Text("Show in Crew")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Palette.muted)
                }
            }
            }

            // What only the owner of a computer can use: a person invited to one sees none of it.
            let online = accounts.ownedComputers.compactMap { accounts.store(for: $0.id) }.filter { $0.connection == .online }
            if showsSettings, !online.isEmpty {
                CardSection("Voice chat", footer: "Apple speech on this iPhone, or OpenAI and Gemini on your own API key, kept on the computer.") {
                    ForEach(online, id: \.computer.id) { store in
                        Button { voicePage = store.computer.id } label: {
                            LinkRow {
                                Label(online.count > 1 ? "Voice chat on \(store.hostName)" : "Voice and API keys", systemImage: "waveform")
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            // Linking their own Telegram or Discord account is for an invited person too.
            if showsSettings, let linkStore = online.first ?? accounts.computers.compactMap({ accounts.store(for: $0.id) }).first(where: { $0.connection == .online }) {
                LinkChatSection(store: linkStore)
            }

            if showsSettings, let owner = online.first {
                PeopleSection(store: owner)
            }

            if showsSettings {
            CardSection("Crew", footer: crewOrder == CrewOrderMode.manual.rawValue
                        ? "Your drag order for every room, synced to your computers. Pinned rooms stay on top."
                        : "Pinned rooms first, then rooms that need you, then working, then recent. Pinned rooms can still be dragged.") {
                MenuRow("Crew order", systemImage: "person.2", selection: $crewOrder,
                        options: CrewOrderMode.allCases.map { ($0.rawValue, $0.label) })
                if accounts.computers.isEmpty || !accounts.ownedComputers.isEmpty {
                    Button { widgets = true } label: {
                        LinkRow { Label("Widgets & Live Activities", systemImage: "rectangle.stack") }
                    }
                    .buttonStyle(.plain)
                }
            }

            CardSection("Notifications, display", footer: "Get a result summary, a request for input, or a failure notice. Default text size and appearance follow iOS Settings; Small, Large and Extra large replace it inside Kith.") {
                Toggle("Push notifications", isOn: $notificationsEnabled)
                    .toggleStyle(.kithGreen)
                    .onChange(of: notificationsEnabled) { PushRegistrar.shared.resync() }
                notificationsRow
                MenuRow("Text size", systemImage: "textformat.size", selection: $textSize,
                        options: TextSizePreference.allCases.map { ($0.rawValue, $0.label) })
                MenuRow("Appearance", systemImage: "circle.lefthalf.filled", selection: $appearance,
                        options: AppearancePreference.allCases.map { ($0.rawValue, $0.label) })
            }

            CardSection("Privacy", footer: "Which features you use, never your messages, code or files. Helps us spot bugs sooner and make Kith better for you.") {
                HStack(spacing: 4) {
                    Text("Share usage analytics").lineLimit(1).layoutPriority(1)
                    IconButton("About usage analytics", systemImage: "info.circle") { aboutAnalytics = true }
                    Toggle(isOn: Binding(get: { analyticsEnabled }, set: { Analytics.shared.setEnabled($0) })) { EmptyView() }
                        .toggleStyle(.kithGreen)
                        .accessibilityLabel("Share usage analytics")
                }
            }
            }

            if showsSettings, !hiddenBots.isEmpty {
                CardSection("Hidden bots") {
                    ForEach(hiddenBots) { item in
                        let store = item.store, bot = item.bot
                        HStack {
                            CharacterAvatar(bot: bot, size: 28, animated: false)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(bot.name)
                                Text(store.hostName).font(.caption).foregroundStyle(Palette.tertiary)
                            }
                            Spacer()
                            IconButton("Unhide", systemImage: "eye") {
                                withAnimation(Motion.layout) { store.setHidden(bot, false) }
                            }
                        }
                    }
                }
            }

            if showsSettings {
            CardSection("About") {
                ValueRow("App version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                Button("Source code") { openURL(URL(string: "https://github.com/Ying-Kai-Liao/kith")!) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.text)
                Button("Open-source licenses") { showLicenses = true }
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.text)
            }

            CardSection {
                Button { confirmStartOver = true } label: {
                    Text("Start over…")
                        .foregroundStyle(Palette.danger)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            }
        }
        .navigationDestination(isPresented: $widgets) { WidgetsAndActivitiesView() }
        .navigationDestination(isPresented: $showAccount) { AccountSwitcherView(pushed: true) }
        .navigationDestination(item: $computerPage) { id in
            if let store = accounts.store(for: id) {
                ComputerPage(store: store, revokeTarget: cloudComputer(id).flatMap { $0.access == "granted" ? $0 : nil },
                             openScreen: { openScreen(store) },
                             openMarketplace: { closeSheets { app.marketplace = store.computer.id } })
            }
        }
        .navigationDestination(item: $voicePage) { id in
            if let store = accounts.store(for: id) { VoiceChatSettingsView(pushed: true).environment(store) }
        }
        .kithDialog("Remove the older \(confirmRemoveCopy?.name ?? "computer")?", isPresented: Binding(
            get: { confirmRemoveCopy != nil }, set: { if !$0 { confirmRemoveCopy = nil } }
        ), message: "It's this computer under an earlier identity and can't be reached anymore. Removing it only cleans up your account.") {
            guard let copy = confirmRemoveCopy else { return [] }
            return [DialogAction("Remove", destructive: true) { Task { await accounts.removeFromAccount(copy.computerId) } }]
        }
        .kithDialog("Start over?", isPresented: $confirmStartOver,
                      message: "Signs out of every account and forgets every computer on this iPhone, then shows the welcome again. Your computers keep their bots and chats; pair again to use them.") {
            [DialogAction("Start over", destructive: true) { Task { await app.startOver() } }]
        }
        .refreshable { await accounts.refreshCloud() }
        .page(title, pushed: pushed)
        .task { await accounts.refreshCloud() }
        .kithSheet(isPresented: $addingComputer) {
            PairingView(inModal: true)
        }
        .kithSheet(item: $newChat) { target in NewChatSheet(store: target.store).environment(accounts) }
        .kithSheet(isPresented: $aboutAnalytics) { AnalyticsSheet() }
        .kithSheet(isPresented: $showLicenses) { LicensesSheet() }
        .kithSheet(item: $access) { target in
            AccessRequestView(computer: target.computer, pending: accounts.pendingAccess[target.id] != nil)
        }
        .kithDialog("Remove \(confirmForget?.name ?? "computer")?",
                      isPresented: Binding(get: { confirmForget != nil }, set: { if !$0 { confirmForget = nil } }),
                      message: "Its bots and conversations stay on that computer. You can pair again any time.") {
            [DialogAction("Remove", destructive: true) {
                if let c = confirmForget { accounts.forget(c.id) }
            }]
        }
        .kithDialog("Revoke this iPhone's access to \(confirmRevoke?.name ?? "the computer")?",
                      isPresented: Binding(get: { confirmRevoke != nil }, set: { if !$0 { confirmRevoke = nil } }),
                      message: "You can ask for access again; the computer will show a new code to confirm.") {
            [DialogAction("Revoke", destructive: true) {
                if let c = confirmRevoke { Task { await app.revokeAccess(c.computerId) } }
            }]
        }
        .task { notificationsAllowed = await PushRegistrar.shared.isAllowed() }
        .task { if app.openWidgets { app.openWidgets = false; widgets = true } }
        .onChange(of: app.openWidgets) { _, open in if open { app.openWidgets = false; widgets = true } }
    }


    private struct VoiceTarget: Identifiable {
        let store: BotStore
        let id: String

        @MainActor init(store: BotStore) {
            self.store = store
            id = store.computer.id
        }
    }

    private struct AccessTarget: Identifiable {
        let computer: CloudComputer
        var id: ComputerID { computer.computerId }
    }

    private func cloudComputer(_ id: ComputerID) -> CloudComputer? {
        accounts.cloudComputers.first { $0.computerId == id }
    }

    /// Account computers this iPhone isn't set up for yet.
    private var accountOnly: [CloudComputer] {
        accounts.cloudComputers.filter { c in !accounts.computers.contains { $0.id == c.computerId } }
    }

    private struct HiddenBot: Identifiable {
        let store: BotStore
        let bot: Bot
        let id: String
    }

    private var hiddenBots: [HiddenBot] {
        accounts.computers.compactMap { accounts.store(for: $0.id) }.flatMap { store in
            store.hiddenBots.map { HiddenBot(store: store, bot: $0, id: "\(store.computer.id)/\($0.id)") }
        }
    }

    /// This screen is a sheet of its own or inside Accounts; the marketplace and screen open over the app,
    /// once that sheet has slid away.
    private func closeSheets(then open: @escaping @MainActor () -> Void) {
        dismissModal()
        Task {
            try? await Task.sleep(for: .milliseconds(450))
            open()
        }
    }

    private func openScreen(_ store: BotStore) {
        closeSheets { store.screenRequest = ScreenRequest() }
    }

    private var notificationsRow: some View {
        Button {
            if notificationsAllowed != nil {
                UIApplication.shared.open(URL(string: UIApplication.openNotificationSettingsURLString)!)
            } else {
                Task { notificationsAllowed = await PushRegistrar.shared.requestAuthorization() }
            }
        } label: {
            ValueRow("Notifications", value: notificationsAllowed == true ? "On" : notificationsAllowed == false ? "Off in Settings" : "Turn on")
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The account at the top: your sky picture (or photo), who you are, how much is in the account; opens the account page.
private struct AccountCard: View {
    let open: () -> Void
    @Environment(AccountSession.self) private var account
    @Environment(AccountStore.self) private var accounts

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                if let url = account.avatarURL {
                    AccountAvatar(url: url, email: account.email, size: 44)
                } else {
                    SkyPatch(id: account.userID ?? "you", size: 44, isYou: true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1).truncationMode(.middle)
                    Text(subtitle).font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.tertiary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Account")
        .accessibilityValue("\(title), \(subtitle)")
    }

    private var title: String { account.isSignedIn ? (account.email ?? "Kith account") : "Not signed in" }

    private var subtitle: String {
        let count = accounts.computers.count
        let computers = count == 0 ? "No computers" : count == 1 ? "1 computer" : "\(count) computers"
        return account.isSignedIn ? computers : "Sign in or scan a computer's code"
    }
}

/// A computer this account joined by invite: its name and role, a way to start a chat, and nothing of the owner's.
private struct MemberComputerRow: View {
    let store: BotStore
    @Binding var shown: Bool
    let newChat: () -> Void
    let remove: () -> Void
    @Environment(AccountStore.self) private var accounts

    var body: some View {
        HStack(spacing: 12) {
            ComputerTile(store.computer)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(store.hostName) · \(accounts.access(for: store.computer.id).title)")
                    .font(.body.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                Text(store.connection == .online ? "Online" : "Not connected")
                    .font(.subheadline).foregroundStyle(Palette.secondary)
            }
            Spacer(minLength: 8)
            if store.connection == .online { IconButton("New chat", systemImage: "square.and.pencil", action: newChat) }
            IconButton("Remove", systemImage: "trash", action: remove)
            ShowInCrewSwitch(name: store.hostName, isOn: $shown)
        }
    }
}

/// The switch at the end of a computer's row: whether its rooms show in Crew on this iPhone.
struct ShowInCrewSwitch: View {
    let name: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) { EmptyView() }
            .toggleStyle(.kithGreen)
            .labelsHidden()
            .accessibilityLabel("Show \(name) in Crew")
    }
}

/// A computer this iPhone can use: tap for its page, the switch for Crew, long-press for the quick actions.
private struct ComputerRow: View {
    let store: BotStore
    @Binding var shown: Bool
    let open: () -> Void
    let openScreen: () -> Void
    /// Agents, connectors and skills installed on this computer.
    let openMarketplace: () -> Void
    let openVoice: () -> Void
    /// Set when this iPhone's access to the computer can be revoked.
    let revoke: (() -> Void)?
    let remove: () -> Void
    @Environment(AccountStore.self) private var accounts
    @State private var coloring = false

    var body: some View {
        HStack(spacing: 12) {
            Button(action: open) {
                HStack(spacing: 12) {
                    ComputerTile(store.computer)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.hostName).font(.body.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                        subtitle
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            ShowInCrewSwitch(name: store.hostName, isOn: $shown)
        }
        .padding(.vertical, 2)
        .contextActions {
            var items = [MenuItem("Colour", icon: "paintpalette") { coloring = true }]
            if !stale { items.append(MenuItem("Route", detail: routeDetail, icon: "wifi", action: open)) }
            if store.connection == .online {
                items.append(MenuItem("Extensions", icon: "square.grid.2x2", action: openMarketplace))
                items.append(MenuItem("Voice chat", icon: "waveform", action: openVoice))
                if store.screen != nil { items.append(MenuItem("Show screen", icon: "display", action: openScreen)) }
                if accounts.role(for: store.computer.id) != .member { items.append(MenuItem("Backups", icon: "archivebox", action: open)) }
            }
            if let revoke {
                items.append(MenuItem("Revoke this iPhone's access", icon: "lock.slash", destructive: true, divider: true, action: revoke))
            }
            items.append(MenuItem("Remove", icon: "trash", destructive: true, divider: revoke == nil, action: remove))
            return items
        }
        .kithOverlay(isPresented: $coloring) { close in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture(perform: close)
                SwatchPanel(selected: store.computer.color) { id in
                    close()
                    accounts.setColor(store.computer.id, id)
                }
                .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .shadow(color: .black.opacity(0.25), radius: 24, y: 10)
            }
            .accessibilityAddTraits(.isModal)
        }
    }

    private var stale: Bool { accounts.isStale(store.computer.id) }

    /// "6 bots" and the route in use, or why the computer is out of reach.
    @ViewBuilder private var subtitle: some View {
        if store.connection == .online {
            let count = store.roster.count
            HStack(spacing: 4) {
                Text("\(count) bot\(count == 1 ? "" : "s")")
                if store.hostRoute != nil {
                    Text("·")
                    RouteIcon(route: store.hostRoute)
                    Text(store.hostRoute == .relay ? "Cloudflare" : "Wi-Fi")
                }
            }
            .font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(1)
        } else {
            Text(accounts.statusText(store))
                .font(.subheadline).foregroundStyle(store.isOffline ? Palette.warning : Palette.secondary).lineLimit(2)
        }
    }

    private var routeDetail: String {
        let now = store.hostRoute == .relay ? "Cloudflare" : "Wi-Fi"
        return "\(now) now · or Tailscale, Cloudflare"
    }
}

/// A computer in the account that this iPhone can't use yet.
private struct AccountComputerRow: View {
    let computer: CloudComputer
    let ticket: AccessTicket?
    let ask: () -> Void
    let revoke: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ComputerTile(Computer(id: computer.computerId, name: computer.name, signKey: computer.signKey, device: computer.device))
                .opacity(0.5)
            VStack(alignment: .leading, spacing: 2) {
                Text(computer.name).font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                Text(detail).font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            if ticket != nil {
                Button("Code", action: ask).buttonStyle(.secondary)
            } else if computer.access == "granted" {
                Button("Revoke", role: .destructive, action: revoke).buttonStyle(.secondary)
            } else {
                Button("Ask for access", action: ask).buttonStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        let online = computer.isOnline ? "Online" : "Offline"
        if let ticket { return "Waiting for your OK on the computer · \(ticket.code)" }
        return switch computer.access {
        case "granted": "Approved for an earlier install of Kith. Revoke it, then ask again."
        case "pending": "\(online) · A request is waiting"
        default: "no access yet"
        }
    }
}

/// The same machine under an earlier identity: one tap cleans it out of the account.
private struct OlderCopyRow: View {
    let computer: CloudComputer
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ComputerTile(Computer(id: computer.computerId, name: computer.name, signKey: computer.signKey, device: computer.device))
                .opacity(0.35)
            VStack(alignment: .leading, spacing: 2) {
                Text(computer.name).font(.body.weight(.semibold)).foregroundStyle(Palette.secondary)
                Text(detail).font(.subheadline).foregroundStyle(Palette.tertiary).lineLimit(2)
            }
            Spacer(minLength: 8)
            IconButton("Remove from account", systemImage: "trash", action: remove)
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        let seen = computer.lastSeenAt.map { " · last seen \(RelativeTime.day(Date(milliseconds: $0)))" } ?? ""
        return "Older copy of this computer\(seen)"
    }
}

/// A row whose value is picked from a stock menu (Crew order, Text size).
struct MenuRow<ID: Hashable>: View {
    let title: String
    let systemImage: String
    @Binding var selection: ID
    let options: [(ID, String)]

    init(_ title: String, systemImage: String, selection: Binding<ID>, options: [(ID, String)]) {
        self.title = title
        self.systemImage = systemImage
        _selection = selection
        self.options = options
    }

    var body: some View {
        DropdownMenu {
            options.map { option in
                MenuItem(option.1, selected: option.0 == selection) { selection = option.0 }
            }
        } label: {
            HStack {
                Label(title, systemImage: systemImage).foregroundStyle(Palette.text)
                Spacer(minLength: 8)
                Text(options.first { $0.0 == selection }?.1 ?? "").foregroundStyle(Palette.secondary)
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Palette.tertiary)
            }
            .contentShape(Rectangle())
        }
    }
}

/// A navigation row label with a trailing chevron.
struct LinkRow<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack {
            content.foregroundStyle(Palette.text)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// The computer color choices: a grid of colored dots, the current one checked.
struct SwatchPanel: View {
    let selected: String?
    let pick: (String) -> Void

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(36), spacing: 10), count: 6), spacing: 10) {
            ForEach(AvatarPalette.colors) { swatch in
                Button { pick(swatch.id) } label: {
                    Circle().fill(swatch.color)
                        .frame(width: 32, height: 32)
                        .overlay {
                            if selected == swatch.id {
                                Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.white)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(swatch.label)
                .accessibilityAddTraits(selected == swatch.id ? .isSelected : [])
            }
        }
        .padding(14)
    }
}

extension ConnectionRoute {
    var title: String {
        switch self {
        case .automatic: "Auto: Wi-Fi or Tailscale, then Cloudflare"
        case .cloudflareFirst: "Cloudflare, then Wi-Fi or Tailscale"
        case .directOnly: "Wi-Fi or Tailscale only, never Cloudflare"
        }
    }

    var icon: String {
        switch self {
        case .automatic: "arrow.triangle.branch"
        case .cloudflareFirst: "cloud"
        case .directOnly: "wifi"
        }
    }
}

/// The in-app text size: Default leaves iOS Dynamic Type alone; the others replace it for the whole app.
enum TextSizePreference: String, CaseIterable {
    case system, small, large, extraLarge

    static let key = "textSize"

    var label: String {
        switch self {
        case .system: "Default"
        case .small: "Small"
        case .large: "Large"
        case .extraLarge: "Extra large"
        }
    }

    /// nil means no override (iOS's own setting applies, as before this setting existed).
    var size: DynamicTypeSize? {
        switch self {
        case .system: nil
        case .small: .small
        case .large: .xLarge
        case .extraLarge: .xxxLarge
        }
    }

    init(stored: String) { self = TextSizePreference(rawValue: stored) ?? .system }
}

private struct TextSizeOverride: ViewModifier {
    @AppStorage(TextSizePreference.key) private var stored = TextSizePreference.system.rawValue

    @Environment(\.dynamicTypeSize) private var system

    /// One branch only: a conditional would give the root two view identities and reset navigation
    /// and open sheets whenever the setting changes.
    func body(content: Content) -> some View {
        content.dynamicTypeSize(TextSizePreference(stored: stored).size ?? system)
    }
}

extension View {
    /// Applies the Text size setting; put it once at the app root.
    func appTextSize() -> some View { modifier(TextSizeOverride()) }
}

/// "Link Telegram or Discord": a one-time code that ties a chat account to your Kith person.
/// Hidden when the computer's host is older than the `linkCode` method.
struct LinkChatSection: View {
    let store: BotStore
    @State private var code: LinkCode?
    @State private var busy = false
    @State private var unsupported = false
    @State private var copied = false
    @State private var error: String?

    var body: some View {
        if !unsupported {
            CardSection("Link Telegram or Discord", footer: error ?? "Chat with your bots from your own Telegram or Discord account.") {
                if let code {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(code.code)
                            .font(.system(size: 34, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Palette.text)
                            .textSelection(.enabled)
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            let minutes = max(1, Int((code.expiry.timeIntervalSince(context.date) / 60).rounded()))
                            Text("Send /link \(code.code) to your Kith bot in Telegram or Discord. Expires in about \(minutes) min.")
                                .font(.footnote)
                                .foregroundStyle(Palette.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = "/link \(code.code)"
                        copied = true
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.text)
                }
                Button { Task { await request() } } label: {
                    Label(code == nil ? "Get a link code" : "New code", systemImage: "link")
                        .foregroundStyle(Palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
    }

    private func request() async {
        guard !busy, let client = store.client else { return }
        busy = true
        error = nil
        copied = false
        defer { busy = false }
        do {
            code = try await client.linkCode()
        } catch let HostError.http(status, message) where status == 404 || message.localizedCaseInsensitiveContains("unknown method") {
            // An older host doesn't know the method: the row goes away rather than failing.
            unsupported = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The in-app appearance: System follows iOS; Light and Dark replace it for the whole app.
enum AppearancePreference: String, CaseIterable {
    case system, light, dark

    static let key = "appearance"

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// .unspecified means no override. An unknown stored value (from a newer version) falls back to System.
    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }

    init(stored: String) { self = AppearancePreference(rawValue: stored) ?? .system }
}

private struct AppearanceOverride: ViewModifier {
    @AppStorage(AppearancePreference.key) private var stored = AppearancePreference.system.rawValue

    // Set on the UIWindows, not with .preferredColorScheme: SwiftUI's modifier often fails to go back to
    // System after Light/Dark until relaunch, and it is flaky inside presentations. A window-level style
    // is inherited by every sheet and cover, and .unspecified hands control back to the phone.
    func body(content: Content) -> some View {
        content
            .onAppear(perform: apply)
            .onChange(of: stored) { apply() }
            .onReceive(NotificationCenter.default.publisher(for: UIWindow.didBecomeKeyNotification)) { _ in apply() }
            .onReceive(NotificationCenter.default.publisher(for: UIScene.didActivateNotification)) { _ in apply() }
    }

    private func apply() {
        let style = AppearancePreference(stored: stored).interfaceStyle
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows where window.overrideUserInterfaceStyle != style {
                window.overrideUserInterfaceStyle = style
            }
        }
    }
}

extension View {
    /// Applies the Appearance setting; put it once at the app root.
    func appAppearance() -> some View { modifier(AppearanceOverride()) }
}
