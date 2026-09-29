import CodyncKit
import CodyncUI
import SwiftUI

/// The roster: every bot on every computer is a person you can message (Grok Bot sidebar, phone-sized).
struct BotListView: View {
    @Environment(AppStore.self) private var app
    @Environment(AccountStore.self) private var accounts
    @State private var editing: EditTarget?
    @State private var editingGroup: GroupTarget?
    @State private var confirmDelete: RosterItem?
    /// The computer section a dragged heading is over.
    @State private var dropTarget: ComputerID?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Computers left out of the list on this device, comma-separated IDs.
    @AppStorage("hiddenComputers") private var hiddenComputers = ""

    private var shownIDs: Set<ComputerID> {
        Set(ComputerSelection(all: accounts.computers.map(\.id), hidden: hiddenComputers).shown)
    }

    private var shownStores: [BotStore] {
        accounts.computers.filter { shownIDs.contains($0.id) }.compactMap { accounts.store(for: $0.id) }
    }

    /// One computer shows a flat list; more get a heading each.
    private var grouped: Bool { shownStores.count > 1 }

    /// Moves a computer one place up (-1) or down (+1) among the shown ones.
    private func move(_ id: ComputerID, _ offset: Int) {
        let ids = shownStores.map(\.computer.id)
        guard let i = ids.firstIndex(of: id), ids.indices.contains(i + offset) else { return }
        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { accounts.move(id, to: ids[i + offset]) }
    }

    /// Computers that can take a new bot right now.
    private var onlineStores: [BotStore] {
        allStores.filter { $0.connection == .online }
    }

    private var allStores: [BotStore] {
        accounts.computers.compactMap { accounts.store(for: $0.id) }
    }

    var body: some View {
        let roster = accounts.roster.filter { shownIDs.contains($0.ref.computerId) }
        ScrollView {
            LazyVStack(spacing: 0) {
                if roster.isEmpty {
                    EmptyRoster(canCreate: !allStores.isEmpty, hasComputer: !accounts.computers.isEmpty,
                                create: newBot, showComputers: { app.showComputers = true })
                }

                if grouped {
                    // A light heading per computer, in the order the user dragged them into.
                    ForEach(shownStores, id: \.computer.id) { store in
                        let id = store.computer.id
                        VStack(spacing: 0) {
                            ComputerSection(store: store, empty: !roster.contains { $0.ref.computerId == id },
                                            targeted: dropTarget == id, move: move)
                            ForEach(roster.filter { $0.ref.computerId == id }) { row($0, store: store) }
                        }
                        .dropDestination(for: String.self) { ids, _ in
                            guard let dragged = ids.first else { return false }
                            withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { accounts.move(dragged, to: id) }
                            return true
                        } isTargeted: { on in
                            withAnimation(Motion.hover) { dropTarget = on ? id : (dropTarget == id ? nil : dropTarget) }
                        }
                    }
                } else {
                    ForEach(roster) { item in
                        if let store = accounts.store(for: item.ref.computerId) {
                            row(item, store: store)
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
                ComputerFilterHeader(accounts: accounts, hidden: $hiddenComputers) { app.showComputers = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // A native menu: the bar hosts toolbar buttons outside SwiftUI's layout,
                // so an anchored Codync menu can't find where the button is.
                Menu("New", systemImage: "plus") {
                    Button("New bot", systemImage: "plus", action: newBot)
                    Button("New group chat", systemImage: "person.2", action: newGroup)
                        .disabled(onlineStores.isEmpty)
                }
                .disabled(allStores.isEmpty)
            }
        }
        .refreshable {
            for computer in accounts.computers { accounts.store(for: computer.id)?.restartStream() }
            await accounts.refreshCloud()
        }
        .codyncSheet(item: $editing) { target in
            // A new bot can move to another computer until it's created.
            let computerId = editing?.computerId ?? target.computerId
            if let store = accounts.store(for: computerId) {
                BotEditorView(draft: target.draft,
                              computers: allStores.map {
                                  ($0.computer.id, $0.connection == .online ? $0.hostName : "\($0.hostName) (offline)")
                              },
                              computer: target.draft.id == nil
                                  ? Binding(get: { computerId }, set: { editing?.computerId = $0 })
                                  : nil)
                    .environment(store)
                    .onChange(of: store.selection) { _, botId in
                        // A new bot opens its chat, on the computer it was created on.
                        guard let botId else { return }
                        store.selection = nil
                        accounts.selection = BotReference(accountId: accounts.accountId, computerId: computerId, botId: botId)
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
        .codyncDialog("Delete \(confirmDelete?.bot.name ?? "bot")?",
                      isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                      message: confirmDelete?.bot.isGroup == true ? "Its bots and their own chats stay." : "Files it changed on your computer stay as they are.") {
            let item = confirmDelete
            return [DialogAction(item?.bot.isGroup == true ? "Delete group chat" : "Delete bot and its conversation", destructive: true) {
                if let item { accounts.store(for: item.ref.computerId)?.delete(item.bot) }
            }]
        }
    }

    private func row(_ item: RosterItem, store: BotStore) -> some View {
        let bot = item.bot
        // A plain button instead of a NavigationLink: same push, no chevron.
        return Button { accounts.selection = item.ref } label: {
            BotRow(bot: bot)
                .environment(store)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accounts.computers.count > 1 ? "\(bot.name), on \(store.hostName)" : bot.name)
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

    /// A new bot starts on the first computer online; the editor's Computer row can move it.
    private func newBot() {
        guard let store = onlineStores.first ?? allStores.first else { return }
        editing = EditTarget(computerId: store.computer.id, draft: BotDraft())
    }
}

/// A computer's heading above its bots: badge, name and connection. Long-press and drag it onto
/// another computer's section to reorder.
private struct ComputerSection: View {
    let store: BotStore
    let empty: Bool
    let targeted: Bool
    let move: (ComputerID, Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                ComputerBadge(store.computer, size: 18)
                Text(store.hostName)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.secondary)
                    .lineLimit(1)
                Text(store.statusText)
                    .font(.footnote)
                    .foregroundStyle(store.isOffline ? Palette.warning : Palette.tertiary)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                if store.connection == .online {
                    RouteIcon(route: store.hostRoute).font(.caption2).foregroundStyle(Palette.tertiary)
                }
                Spacer(minLength: 8)
                Image(systemName: "line.3.horizontal")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(targeted ? Palette.bubbleAgent : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
            .draggable(store.computer.id) {
                HStack(spacing: 6) {
                    ComputerBadge(store.computer, size: 18)
                    Text(store.hostName).font(.footnote.weight(.semibold)).foregroundStyle(Palette.text)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Palette.bubbleAgent, in: Capsule())
            }
            if empty {
                Text("No bots yet")
                    .font(.footnote)
                    .foregroundStyle(Palette.tertiary)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 4)
            }
        }
        .padding(.top, 14)
        .padding(.bottom, 2)
        .padding(.horizontal, -8)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint("Drag to reorder computers")
        .accessibilityActions {
            Button("Move up") { move(store.computer.id, -1) }
            Button("Move down") { move(store.computer.id, 1) }
        }
    }
}

private struct GroupTarget: Identifiable {
    let id = UUID()
    let computerId: ComputerID
    let group: Bot?
}

private struct EditTarget: Identifiable {
    let id = UUID()
    var computerId: ComputerID
    let draft: BotDraft
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
