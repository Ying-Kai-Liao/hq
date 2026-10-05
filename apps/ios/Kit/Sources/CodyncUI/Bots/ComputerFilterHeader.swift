import CodyncKit
import SwiftUI

/// The roster's only connection surface: a quiet summary, with details and filters on demand.
public struct ComputerFilterHeader: View {
    let accounts: AccountStore
    @Binding var hidden: String
    let manage: () -> Void
    let compact: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(accounts: AccountStore, hidden: Binding<String>, compact: Bool = false, manage: @escaping () -> Void) {
        self.accounts = accounts
        _hidden = hidden
        self.manage = manage
        self.compact = compact
    }

    private var selection: ComputerSelection {
        ComputerSelection(all: accounts.computers.map(\.id), hidden: hidden)
    }

    private var stores: [BotStore] { selection.shown.compactMap { accounts.store(for: $0) } }
    private var summary: String { ConnectionSummary(connections: stores.map(\.shownConnection)).text }

    public var body: some View {
        Menu {
            Button("All computers", systemImage: selection.shown.count == accounts.computers.count ? "checkmark" : "desktopcomputer") { update("") }
            ForEach(accounts.computers) { computer in
                Button {
                    update(selection.toggling(computer.id))
                } label: {
                    Label(computerTitle(computer), systemImage: selection.shown.contains(computer.id) ? "checkmark" : "desktopcomputer")
                }
                .menuActionDismissBehavior(.disabled)
            }
            if accounts.computers.count > 1 {
                Menu("Show only") {
                    ForEach(accounts.computers) { computer in
                        Button(computer.name) { update(selection.only(computer.id)) }
                    }
                }
            }
            Divider()
            Button("Reconnect", systemImage: "arrow.clockwise", action: reconnect)
                .disabled(stores.isEmpty)
            Button("Manage computers", systemImage: "desktopcomputer", action: manage)
        } label: { label }
        .accessibilityLabel("Computers, \(summary). Filter conversations")
    }

    private var label: some View {
        HStack(spacing: 4) {
            if compact {
                Image(systemName: "desktopcomputer")
            } else {
                Text(summary).lineLimit(1).contentTransition(.opacity)
            }
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Palette.secondary)
        .help(summary)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .animation(Motion.reduced(Motion.fade, reduceMotion), value: summary)
    }

    private func computerTitle(_ computer: Computer) -> String {
        guard let store = accounts.store(for: computer.id) else { return computer.name }
        return "\(store.hostName) · \(store.connectionLabel)"
    }

    private func update(_ value: String) {
        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { hidden = value }
    }

    private func reconnect() { for store in stores { store.restartStream() } }
}

public extension BotStore {
    var connectionLabel: String {
        switch shownConnection {
        case .online where mismatch != nil: "Needs update"
        case .online: "Connected"
        case .connecting: "Connecting…"
        case .computerOffline, .offline: "Offline"
        case .unauthorized: "No access"
        case .unpaired: "Not paired"
        }
    }
}
