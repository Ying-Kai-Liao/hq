import KithKit
import SwiftUI

/// Settings → Backups: the order Kith moves a bot's turns to when its own account runs out of usage, and which
/// entries are out until when. Read-only on the phone: the order is edited on the computer, where logging in
/// happens too (Kith → Settings → Usage).
public struct BackupsStatusSection: View {
    @Environment(AccountStore.self) private var accounts

    public init() {}

    public var body: some View {
        // Backups are the owner's: an invited person's computer has none to show.
        let online = accounts.ownedComputers.compactMap { accounts.store(for: $0.id) }.filter { $0.connection == .online }
        ForEach(online, id: \.computer.id) { store in
            BackupsComputerSection(store: store, labeled: online.count > 1)
        }
    }
}

/// One computer's backups: Settings → Computers → the computer's page.
public struct BackupsComputerSection: View {
    let store: BotStore
    let labeled: Bool
    @State private var phase: Phase = .loading

    public init(store: BotStore, labeled: Bool) {
        self.store = store
        self.labeled = labeled
    }

    private enum Phase {
        case loading
        case loaded(Backups)
        case failed(String)
        /// A host from before the call: nothing to show.
        case unsupported
    }

    public var body: some View {
        Group {
            switch phase {
            case .unsupported:
                EmptyView()
            case .loading:
                CardSection(title, footer: footer) { Text("Reading the backups…").foregroundStyle(Palette.secondary) }
            case .failed(let message):
                CardSection(title, footer: footer) { Text(message).foregroundStyle(Palette.danger) }
            case .loaded(let backups):
                CardSection(title, footer: footer) {
                    if backups.global.isEmpty {
                        Text("No backups. Add one on the computer.").foregroundStyle(Palette.secondary)
                    }
                    ForEach(Array(backups.global.enumerated()), id: \.element) { index, id in
                        BackupRow(index: index + 1, entry: backups.entry(id))
                    }
                }
            }
        }
        .task(id: store.computer.id) { await load() }
    }

    private var title: String { labeled ? "Backups on \(store.hostName)" : "Backups" }
    private var footer: String {
        "When an agent's own account runs out of usage, its turns move down this list until the limit lifts. Change the order on the computer."
    }

    private func load() async {
        do {
            phase = .loaded(try await store.ready().backups())
        } catch {
            let text = error.localizedDescription
            phase = text.lowercased().contains("unknown method") ? .unsupported : .failed(text)
        }
    }
}

private struct BackupRow: View {
    let index: Int
    let entry: BackupEntry

    var body: some View {
        let out = entry.isOut()
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text("\(index)").foregroundStyle(Palette.tertiary).monospacedDigit()
                Text(entry.id).lineLimit(1)
                Spacer(minLength: 8)
                Text(entry.state())
                    .font(.footnote)
                    .foregroundStyle(out ? Palette.danger : Palette.secondary)
                    .multilineTextAlignment(.trailing)
            }
            if !entry.ready, !out, let fix = entry.fix {
                Text("On the computer: \(fix)")
                    .font(.footnote.monospaced())
                    .foregroundStyle(Palette.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}
