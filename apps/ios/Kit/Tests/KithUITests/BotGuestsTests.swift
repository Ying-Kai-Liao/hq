import Foundation
import Testing
@testable import KithKit
@testable import KithUI

private let now = Date(timeIntervalSince1970: 1_800_014_400)
private var nowMs: Int64 { Int64(now.timeIntervalSince1970 * 1000) }

private func bot(_ state: BotGuestState, id: String = "bg", owner: String? = "sam", agents: [String] = ["house", "notes"],
                 connected: Bool = false, created: Int64? = nil, lastSeen: Int64? = nil, revoked: Int64? = nil) -> BotGuest {
    BotGuest(botId: id, name: "Rex", state: state, ownerPerson: owner, ownerName: owner == nil ? nil : "Sam", agents: agents,
             connected: connected, createdAt: created ?? nowMs, lastSeenAt: lastSeen, revokedAt: revoked)
}

@Test func rowLinePerState() {
    func line(_ bot: BotGuest, _ viewer: BotViewer = .owner) -> String {
        BotGuestRowModel(bot, viewer: viewer, ownerName: "Kai", now: now).line
    }
    #expect(line(bot(.invited)) == "Invite not used yet")
    #expect(line(bot(.joining)) == "Joining…")
    #expect(line(bot(.pending)) == "Waiting for you")
    #expect(line(bot(.pending, created: nowMs - 2 * 86_400_000)) == "Waiting for you · 2 days")
    #expect(line(bot(.pending), .invitee) == "Waiting for Kai to allow it")
    #expect(line(bot(.active, connected: true)) == "Asks house, notes · online now")
    #expect(line(bot(.active, lastSeen: nowMs - 2 * 3_600_000)) == "Asks house, notes · last asked 2 hours ago")
    #expect(line(bot(.denied)) == "You said no")
    #expect(line(bot(.denied), .invitee) == "Kai said no")
    #expect(line(bot(.revoked, revoked: nowMs - 3_600_000)) == "Removed 1 hour ago")
    #expect(line(bot(.revoked)) == "Removed")
}

@Test func rowActionsPerState() {
    func actions(_ state: BotGuestState, _ viewer: BotViewer = .owner) -> [BotGuestRowModel.Action] {
        BotGuestRowModel(bot(state), viewer: viewer, ownerName: "Kai", now: now).actions
    }
    #expect(actions(.invited) == [.cancelInvite, .newLink])
    #expect(actions(.joining) == [.spinner])
    #expect(actions(.pending) == [.deny, .allow])
    #expect(actions(.pending, .invitee).isEmpty)
    #expect(actions(.active) == [.chevron])
    #expect(actions(.denied).isEmpty && actions(.revoked).isEmpty && actions(.unknown("x")).isEmpty)
}

@Test func requestCardTextAndButtons() {
    let card = DecisionCardModel(botRequest: bot(.pending, agents: ["house", "notes", "finance", "x"]))
    #expect(card.heading == "Sam's bot · Grok")
    #expect(card.question == "Rex wants to ask house, notes and 2 more")
    #expect(card.options.map(\.id) == ["allow", "deny", "always"])
    #expect(card.options.last?.title == "Always allow Sam's bots")
    // Kai's own bot has nobody to always allow.
    #expect(DecisionCardModel(botRequest: bot(.pending, owner: nil)).options.map(\.id) == ["allow", "deny"])
}

@Test func boardCountsPendingBots() {
    let request = BoardComputer(id: "mac", hostName: "Mac", bots: [], entries: [:], botRequests: [bot(.pending)])
    let model = BoardModel(computers: [request], now: now)
    #expect(model.waiting == 1)
    #expect(model.needsYou.first?.botRequest?.botId == "bg")
    #expect(model.needsYou.first?.entry == nil)
    // Nothing to open from the dock for it.
    #expect(model.top == nil)
}

private actor Calls {
    var decisions: [String] = []
    func decide(_ s: String) { decisions.append(s) }
}

private struct FakeHost: BotGuestHost {
    let calls: Calls
    var rows: [BotGuest] = []
    var unknown = false
    func bots() async throws -> [BotGuest] {
        if unknown { throw HostError.http(404, "unknown method") }
        return rows
    }
    func myBots() async throws -> [BotGuest] { try await bots() }
    func createBotInvite(name: String?, provider: String?, agents: [String], botId: String?) async throws -> CreatedBotInvite {
        CreatedBotInvite(botId: "bg", inviteId: "i", expiresAt: 1, link: "l", kithLink: nil, share: "s")
    }
    func decideBot(botId: String, decision: BotDecision, alwaysForOwner: Bool) async throws -> BotGuest? {
        await calls.decide("\(botId):\(decision.rawValue):\(alwaysForOwner)")
        return nil
    }
    func setAutoAllowBots(personId: String, on: Bool) async throws {}
    func revokeBot(botId: String) async throws {}
}

@MainActor @Test func storeLoadsPendingAndAnswersWithAlways() async {
    let calls = Calls()
    let store = BotGuestStore(host: { FakeHost(calls: calls, rows: [bot(.pending), bot(.active, id: "b2")]) }, isOwner: { true })
    await store.refresh()
    #expect(store.requests.map(\.botId) == ["bg"])
    await store.decide(store.requests[0], option: "always")
    #expect(await calls.decisions == ["bg:allow:true"])
}

@MainActor @Test func anInviteeHasNoRequestsAndAnOldHostHidesTheFeature() async {
    let calls = Calls()
    let invitee = BotGuestStore(host: { FakeHost(calls: calls, rows: [bot(.pending)]) }, isOwner: { false })
    await invitee.refresh()
    #expect(invitee.requests.isEmpty && invitee.mine.count == 1)
    let old = BotGuestStore(host: { FakeHost(calls: calls, unknown: true) }, isOwner: { true })
    await old.refresh()
    #expect(old.unsupported && old.error == nil)
}
