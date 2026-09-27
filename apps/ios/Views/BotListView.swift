import CodyncKit
import CodyncUI
import SwiftUI

/// The roster: every bot on every computer is a person you can message (Grok Bot sidebar, phone-sized).
struct BotListView: View {
    @Environment(AppStore.self) private var app
    @Environment(AccountStore.self) private var accounts
    @State private var connectingComputer: CloudComputer?
    @State private var editing: EditTarget?
    @State private var editingGroup: GroupTarget?
    @State private var pickingComputer = false
    @State private var confirmDelete: RosterItem?
    /// Computers left out of the list on this device, comma-separated IDs.
    @AppStorage("hiddenComputers") private var hiddenComputers = ""

    private var hidden: Set<ComputerID> { Set(hiddenComputers.split(separator: ",").map(String.init)) }

    /// More than one computer: the list groups bots under their computer and the header filters.
    private var grouped: Bool { accounts.computers.count > 1 }

    /// The computers the list shows (all of them when the filter would leave none).
    private var shownComputers: [Computer] {
        let shown = accounts.computers.filter { !hidden.contains($0.id) }
        return shown.isEmpty ? accounts.computers : shown
    }

    /// Computers that can take a new bot right now.
    private var onlineStores: [BotStore] {
        accounts.computers.compactMap { accounts.store(for: $0.id) }.filter { $0.connection == .online }
    }

    var body: some View {
        let roster = accounts.roster
        ScrollView {
            LazyVStack(spacing: 0) {
                // Keep actionable offline warnings; transient connecting state lives in the header.
                ForEach(shownComputers) { computer in
                    // Connecting draws nothing here (the header shows it), so it takes no space either.
                    if let store = accounts.store(for: computer.id), ![.online, .connecting, .unpaired].contains(store.connection) {
                        ConnectionBanner()
                            .environment(store)
                            .padding(.vertical, 4)
                    }
                }

                if !accountComputers.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Connect from your account")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Palette.text)
                        Text("Connect once to see all the bots on your computer. No QR code needed.")
                            .font(.subheadline)
                            .foregroundStyle(Palette.secondary)
                        ForEach(accountComputers) { computer in
                            Button {
                                withAnimation(Motion.layout) {
                                    if computer.access == "granted" {
                                        app.showComputers = true
                                    } else {
                                        connectingComputer = computer
                                    }
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "desktopcomputer")
                                        .font(.title2)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(computer.name).font(.headline)
                                        Text(computer.isOnline ? "Online" : "Offline · Turn on your computer to connect")
                                            .font(.subheadline)
                                            .foregroundStyle(Palette.secondary)
                                    }
                                    Spacer()
                                    Text(computer.access == "granted" ? "Manage" : "Connect")
                                        .font(.subheadline.weight(.semibold))
                                }
                                .foregroundStyle(Palette.text)
                                .padding(16)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
                            }
                            .buttonStyle(PressScale())
                        }
                    }
                    .padding(.vertical, 16)
                }

                if roster.isEmpty && accountComputers.isEmpty {
                    EmptyRoster(canCreate: !onlineStores.isEmpty, hasComputer: !accounts.computers.isEmpty,
                                create: newBot, showComputers: { app.showComputers = true })
                }

                if grouped {
                    ForEach(shownComputers) { computer in
                        if let store = accounts.store(for: computer.id) {
                            ComputerSection(store: store)
                            ForEach(roster.filter { $0.ref.computerId == computer.id }) { item in
                                row(item, store: store, caption: false)
                            }
                        }
                    }
                } else {
                    ForEach(roster) { item in
                        if let store = accounts.store(for: item.ref.computerId) {
                            row(item, store: store, caption: true)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .background(Palette.background)
        .navigationTitle("Bots")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                AccountSwitcherButton()
            }
            ToolbarItem(placement: .principal) {
                if grouped {
                    VStack(spacing: 0) {
                        filterButton
                        ConnectingIndicator(isConnecting: shownComputers.contains {
                            accounts.store(for: $0.id)?.connection == .connecting
                        })
                    }
                } else {
                    // Keep the center empty when connected, while the system owns the bar's layout.
                    ZStack {
                        Color.clear.frame(width: 1, height: 1)
                        ConnectingIndicator(isConnecting: accounts.computers.contains {
                            accounts.store(for: $0.id)?.connection == .connecting
                        })
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Computers", systemImage: "desktopcomputer") { app.showComputers = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // A native menu: the bar hosts toolbar buttons outside SwiftUI's layout,
                // so an anchored Codync menu can't find where the button is.
                Menu("New", systemImage: "plus") {
                    Button("New bot", systemImage: "plus", action: newBot)
                    Button("New group chat", systemImage: "person.2", action: newGroup)
                }
                .disabled(onlineStores.isEmpty)
            }
        }
        .refreshable {
            for computer in accounts.computers { accounts.store(for: computer.id)?.restartStream() }
            await accounts.refreshCloud()
        }
        .codyncSheet(item: $connectingComputer) { computer in
            AccessRequestView(computer: computer, pending: accounts.pendingAccess[computer.id] != nil)
        }
        .codyncSheet(item: $editing) { target in
            if let store = accounts.store(for: target.computerId) {
                BotEditorView(draft: target.draft)
                    .environment(store)
                    .onChange(of: store.selection) { _, botId in
                        // A new bot opens its chat, on the computer it was created on.
                        guard let botId else { return }
                        store.selection = nil
                        accounts.selection = BotReference(accountId: accounts.accountId, computerId: target.computerId, botId: botId)
                    }
            }
        }
        .codyncSheet(item: $editingGroup) { target in
            if let store = accounts.store(for: target.computerId) {
                GroupEditorView(group: target.group)
                    .environment(store)
                    .onChange(of: store.selection) { _, botId in
                        guard let botId else { return }
                        store.selection = nil
                        accounts.selection = BotReference(accountId: accounts.accountId, computerId: target.computerId, botId: botId)
                    }
            }
        }
        .codyncSheet(isPresented: $pickingComputer) {
            ComputerPicker(stores: onlineStores) { store in
                // Let the picker slide away before the editor slides up.
                Task {
                    try? await Task.sleep(for: .milliseconds(450))
                    editing = EditTarget(computerId: store.computer.id, draft: BotDraft())
                }
            }
        }
        .codyncDialog("Delete \(confirmDelete?.bot.name ?? "bot")?",
                      isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                      message: confirmDelete?.bot.isGroup == true ? "Its bots and their own chats stay." : "Files it changed on your computer stay as they are.") {
            let item = confirmDelete
            return [DialogAction(item?.bot.isGroup == true ? "Delete group chat" : "Delete bot and its conversation", destructive: true) {
                if let item { accounts.store(for: item.ref.computerId)?.delete(item.bot) }
            }]
        }
    }

    private var accountComputers: [CloudComputer] {
        accounts.cloudComputers.filter { computer in
            !accounts.computers.contains { $0.id == computer.id }
        }
    }

    /// "All computers ⌄" / "MacBook ⌄" / "2 computers ⌄".
    private var filterButton: some View {
        let shown = shownComputers
        let title = shown.count == accounts.computers.count ? "All computers"
            : shown.count == 1 ? (accounts.store(for: shown[0].id)?.hostName ?? shown[0].name)
            : "\(shown.count) computers"
        return Menu {
            Button { setHidden([]) } label: {
                Label("All computers", systemImage: shown.count == accounts.computers.count ? "checkmark" : "square.stack")
            }
            Divider()
            ForEach(accounts.computers) { computer in
                let isShown = shown.contains { $0.id == computer.id }
                // A tap toggles one computer; the last one shown stays.
                Button {
                    guard !isShown || shown.count > 1 else { return }
                    setHidden(isShown ? hidden.union([computer.id]) : hidden.subtracting([computer.id]))
                } label: {
                    Label(accounts.store(for: computer.id)?.hostName ?? computer.name,
                          systemImage: isShown ? "checkmark" : "desktopcomputer")
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .contentTransition(.opacity)
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.tertiary)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .contentShape(Rectangle())
            .animation(Motion.layout, value: title)
        }
        .accessibilityLabel("Show computers: \(title)")
    }

    private func setHidden(_ ids: Set<ComputerID>) {
        withAnimation(Motion.layout) { hiddenComputers = ids.sorted().joined(separator: ",") }
    }

    private func row(_ item: RosterItem, store: BotStore, caption: Bool) -> some View {
        let bot = item.bot
        // A plain button instead of a NavigationLink: same push, no chevron.
        return Button { accounts.selection = item.ref } label: {
            VStack(alignment: .leading, spacing: 0) {
                BotRow(bot: bot)
                if caption {
                    ComputerCaption(store: store)
                        .padding(.leading, 58)
                        .padding(.bottom, 6)
                        .offset(y: -6)
                }
            }
            .environment(store)
        }
        .buttonStyle(.plain)
        .contextActions {
            [
                MenuItem(bot.pinned ? "Unpin" : "Pin", icon: bot.pinned ? "pin.slash" : "pin") { store.setPinned(bot, !bot.pinned) },
                bot.isGroup
                    ? MenuItem("Edit group", icon: "person.2") { editingGroup = GroupTarget(computerId: item.ref.computerId, group: bot) }
                    : MenuItem("Edit profile", icon: "pencil") { editing = EditTarget(computerId: item.ref.computerId, draft: BotDraft(bot)) },
                MenuItem("Mark as read", icon: "checkmark.message") { store.markAllRead(bot.id) },
                MenuItem("Hide from list", icon: "eye.slash") { store.setHidden(bot, true) },
                MenuItem("Delete", icon: "trash", destructive: true, divider: true) { confirmDelete = item },
            ]
        }
    }

    /// A group chat gathers bots of one computer (the first one online; more computers are future work).
    private func newGroup() {
        guard let store = onlineStores.first else { return }
        Task {
            // Let the menu fold away before the editor slides up.
            try? await Task.sleep(for: .milliseconds(200))
            editingGroup = GroupTarget(computerId: store.computer.id, group: nil)
        }
    }

    /// A new bot lives on one computer: pick it first when there's a choice.
    private func newBot() {
        let stores = onlineStores
        if stores.count == 1, let store = stores.first {
            editing = EditTarget(computerId: store.computer.id, draft: BotDraft())
        } else if stores.count > 1 {
            pickingComputer = true
        }
    }
}

/// A computer's heading above its bots: badge, name, and its connection, changing in place.
private struct ComputerSection: View {
    let store: BotStore

    var body: some View {
        HStack(spacing: 6) {
            ComputerBadge(store.computer, size: 18)
            Text(store.hostName)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.secondary)
                .lineLimit(1)
            Text(store.statusText)
                .font(.footnote)
                .foregroundStyle(store.isOffline ? Palette.warning : Palette.tertiary)
                .contentTransition(.opacity)
            if store.connection == .online {
                RouteIcon(route: store.hostRoute).font(.caption2).foregroundStyle(Palette.tertiary)
            }
            Spacer()
        }
        .padding(.top, 18)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct GroupTarget: Identifiable {
    let id = UUID()
    let computerId: ComputerID
    let group: Bot?
}

private struct EditTarget: Identifiable {
    let id = UUID()
    let computerId: ComputerID
    let draft: BotDraft
}

/// "Which computer should it run on?" — only computers that are online.
private struct ComputerPicker: View {
    let stores: [BotStore]
    let pick: (BotStore) -> Void
    @Environment(\.dismissModal) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader("Run it on")
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(stores, id: \.computer.id) { store in
                        Button {
                            dismiss()
                            pick(store)
                        } label: {
                            HStack(spacing: 12) {
                                ComputerBadge(store.computer, size: 36)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(store.hostName).font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                                    Text("\(store.roster.count) bot\(store.roster.count == 1 ? "" : "s")")
                                        .font(.subheadline).foregroundStyle(Palette.secondary)
                                }
                                Spacer()
                                RouteIcon(route: store.hostRoute).foregroundStyle(Palette.tertiary)
                            }
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressScale())
                    }
                }
            }
        }
    }
}

private struct EmptyRoster: View {
    let canCreate: Bool
    let hasComputer: Bool
    let create: () -> Void
    let showComputers: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            CharacterAvatar(shape: "cloud", color: "green", size: 72)
            Text("No bots yet").font(.title3.weight(.semibold)).foregroundStyle(Palette.text)
            Text(hasComputer
                 ? "Create a bot for each kind of work — a reviewer, a fixer, a docs writer — and point it at a project."
                 : "Ask one of your account's computers for access, or pair one with its code.")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
            if canCreate {
                Button("Create your first bot", action: create)
                    .buttonStyle(.primary)
            } else if !hasComputer {
                Button("Computers", action: showComputers)
                    .buttonStyle(.primary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}
