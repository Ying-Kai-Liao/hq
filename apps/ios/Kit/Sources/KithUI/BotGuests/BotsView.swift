import KithKit
import SwiftUI

/// A sheet the bot screens open: the invite form (with agents ticked, or a finished invite) or one bot's detail.
public struct BotSheetTarget: Identifiable {
    public enum Kind {
        case invite(preset: Set<String>, result: InviteBotSheet.Result?)
        case detail(BotGuest)
    }

    public let id = UUID()
    public let store: BotStore
    public let kind: Kind

    public init(store: BotStore, kind: Kind) {
        self.store = store
        self.kind = kind
    }

    public static func invite(on store: BotStore, preset: Set<String> = []) -> BotSheetTarget {
        BotSheetTarget(store: store, kind: .invite(preset: preset, result: nil))
    }

    /// A fresh invite for a bot already there (its first link is lost or used); the result shows at once. Nil when the
    /// host refused (the store's `error` says why).
    @MainActor public static func newLink(for bot: BotGuest, on store: BotStore) async -> BotSheetTarget? {
        guard let made = await store.botGuests.createInvite(name: nil, provider: nil, agents: [], botId: bot.botId) else { return nil }
        let result = InviteBotSheet.Result(invite: made, name: bot.name, provider: bot.provider)
        return BotSheetTarget(store: store, kind: .invite(preset: [], result: result))
    }
}

public extension View {
    /// Presents `target` as a Kith sheet.
    func botSheets(_ target: Binding<BotSheetTarget?>, viewer: BotViewer) -> some View {
        kithSheet(item: target) { target in
            switch target.kind {
            case let .invite(preset, result):
                InviteBotSheet(store: target.store, preset: preset, result: result)
            case let .detail(bot):
                BotDetailView(bot: bot, viewer: viewer, store: target.store)
            }
        }
    }
}

/// An invited person's bots: one section per computer they are a member of, each with the bots they invited there.
public struct BotsView: View {
    let stores: [BotStore]
    @State private var target: BotSheetTarget?

    public init(stores: [BotStore]) { self.stores = stores }

    public var body: some View {
        CardForm {
            ForEach(stores, id: \.computer.id) { store in
                BotsComputerSection(store: store, target: $target)
            }
        }
        .background(Palette.background)
        .safeAreaInset(edge: .top, spacing: 0) { ModalHeader("Your bots") }
        .refreshable { for store in stores { await store.botGuests.refresh() } }
        .botSheets($target, viewer: .invitee)
    }
}

private struct BotsComputerSection: View {
    let store: BotStore
    @Binding var target: BotSheetTarget?

    private var guests: BotGuestStore { store.botGuests }

    var body: some View {
        let live = BotGuestStore.live(guests.bots)
        CardSection(store.hostName,
                    footer: "\(BotGuestRowModel.sentenceCase(store.ownerCalled)) can see what your bots ask, and may need to allow them first.") {
            ForEach(live) { bot in
                BotGuestRow(bot: bot, viewer: .invitee, store: store,
                            open: { target = BotSheetTarget(store: store, kind: .detail($0)) },
                            newLink: { bot in Task { if let next = await BotSheetTarget.newLink(for: bot, on: store) { target = next } } })
            }
            Button { target = .invite(on: store) } label: {
                Label("Invite a bot", systemImage: "plus")
                    .foregroundStyle(Palette.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(store.botAgentChoices.isEmpty)
            EndedBots(bots: BotGuestStore.ended(guests.bots), viewer: .invitee, store: store)
        }
        if let error = guests.error {
            Text(error).font(.footnote).foregroundStyle(Palette.danger)
        }
    }
}
