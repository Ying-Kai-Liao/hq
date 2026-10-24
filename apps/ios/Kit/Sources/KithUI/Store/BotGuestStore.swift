import KithKit
import Foundation
import Observation

/// What the bot screens ask of a computer; `HostClient` answers it, a fake does in tests.
public protocol BotGuestHost: Sendable {
    func bots() async throws -> [BotGuest]
    func myBots() async throws -> [BotGuest]
    func createBotInvite(name: String?, provider: String?, agents: [String], botId: String?) async throws -> CreatedBotInvite
    func decideBot(botId: String, decision: BotDecision, alwaysForOwner: Bool) async throws -> BotGuest?
    func setAutoAllowBots(personId: String, on: Bool) async throws
    func revokeBot(botId: String) async throws
}

extension HostClient: BotGuestHost {}

/// The bots from outside (Grok and others) on one computer. The computer's owner sees all of them; an invited person
/// sees their own. The host's events say when to read the list again; nothing is kept between launches, so a pending
/// card comes back from the host on every connect.
@MainActor
@Observable
public final class BotGuestStore {
    public private(set) var bots: [BotGuest] = []
    /// The host doesn't know bot guests (older than the feature): every screen for it stays away.
    public private(set) var unsupported = false
    public private(set) var loaded = false
    /// A write that isn't safe to repeat is in flight (an invite, a removal, the always-allow switch).
    public private(set) var busy = false
    /// Waiting bots whose answer is on its way, with the chosen option: the card disables its buttons.
    public private(set) var deciding: [String: String] = [:]
    public var error: String?

    private let host: @MainActor () -> (any BotGuestHost)?
    private let isOwnerNow: @MainActor () -> Bool
    private var refreshing = false
    private var refreshAgain = false

    public init(host: @escaping @MainActor () -> (any BotGuestHost)?, isOwner: @escaping @MainActor () -> Bool) {
        self.host = host
        self.isOwnerNow = isOwner
    }

    public convenience init(store: BotStore) {
        self.init(host: { [weak store] in store?.client }, isOwner: { [weak store] in store?.isOwner ?? false })
    }

    public var isOwner: Bool { isOwnerNow() }

    // MARK: what the screens read

    /// Waiting for the owner's answer: the cards. Only the computer's owner answers, so an invitee has none.
    public var requests: [BotGuest] {
        isOwner ? bots.filter { $0.state == .pending }.sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.botId < $1.botId } : []
    }

    /// The bots the signed-in person made: the owner's own (no owner person), or all of an invitee's.
    public var mine: [BotGuest] { isOwner ? bots.filter { $0.ownerPerson == nil } : bots }

    /// Bots an invited person made, shown under that person.
    public func bots(of personId: String) -> [BotGuest] { bots.filter { $0.ownerPerson == personId } }

    /// Running or waiting bots, newest first as the host lists them.
    public static func live(_ list: [BotGuest]) -> [BotGuest] { list.filter { !$0.state.isEnded } }
    public static func ended(_ list: [BotGuest]) -> [BotGuest] { list.filter { $0.state.isEnded } }

    public func bot(_ id: String) -> BotGuest? { bots.first { $0.botId == id } }

    /// "2 people · 1 bot": the live bots the owner is responsible for.
    public var liveCount: Int { bots.filter { !$0.state.isEnded }.count }

    // MARK: reading

    /// Reads the list again. Several calls while one runs make one more read after it.
    public func refresh() async {
        guard !unsupported else { return }
        guard !refreshing else {
            refreshAgain = true
            return
        }
        guard let host = host() else { return }
        refreshing = true
        defer { refreshing = false }
        repeat {
            refreshAgain = false
            do {
                let list = isOwner ? try await host.bots() : try await host.myBots()
                bots = list
                loaded = true
            } catch {
                // Anything else (offline, a refusal) leaves what was shown; the next event or connect reads again.
                if InviteProof.isUnknownMethod(error) {
                    unsupported = true
                    bots = []
                    return
                }
            }
        } while refreshAgain
    }

    // MARK: writing

    /// A new bot, or with `botId` a new link for one already there. Nil when it failed (see `error`) or another write is
    /// running: the call isn't safe to repeat.
    public func createInvite(name: String?, provider: String?, agents: [String], botId: String? = nil) async -> CreatedBotInvite? {
        guard !busy, let host = host() else { return nil }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let made = try await host.createBotInvite(name: name, provider: provider, agents: agents, botId: botId)
            await refresh()
            return made
        } catch {
            note(error)
            return nil
        }
    }

    /// Cancels an invite not used yet, or removes the bot.
    @discardableResult
    public func remove(_ botId: String) async -> Bool {
        await write { try await $0.revokeBot(botId: botId) }
    }

    /// The owner turns "always allow this person's bots" on or off; on lets their waiting bots in.
    @discardableResult
    public func setAutoAllow(personId: String, on: Bool) async -> Bool {
        await write { try await $0.setAutoAllowBots(personId: personId, on: on) }
    }

    /// The owner's answer to a waiting bot: "allow", "deny" or "always" (allow, and allow this person's bots from now
    /// on). A second answer while one is on its way does nothing.
    public func decide(_ bot: BotGuest, option: String) async {
        guard deciding[bot.botId] == nil, let host = host() else { return }
        deciding[bot.botId] = option
        error = nil
        defer { deciding[bot.botId] = nil }
        do {
            let decision: BotDecision = option == "deny" ? .deny : .allow
            _ = try await host.decideBot(botId: bot.botId, decision: decision, alwaysForOwner: option == "always")
            await refresh()
        } catch {
            note(error)
        }
    }

    private func note(_ error: Error) {
        if InviteProof.isUnknownMethod(error) {
            unsupported = true
        } else {
            self.error = error.localizedDescription
        }
    }

    @discardableResult
    private func write(_ call: (any BotGuestHost) async throws -> Void) async -> Bool {
        guard !busy, let host = host() else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await call(host)
            await refresh()
            return true
        } catch {
            note(error)
            return false
        }
    }
}

#if DEBUG
extension BotGuestStore {
    /// The `bots-*` demo screens: a fixed list, nothing asked of a host.
    func seedDemo(_ list: [BotGuest]) {
        bots = list
        loaded = true
    }
}
#endif
