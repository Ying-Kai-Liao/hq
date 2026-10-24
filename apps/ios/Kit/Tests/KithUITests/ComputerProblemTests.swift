import Foundation
import Testing
@testable import KithKit
@testable import KithUI

private func mac(_ name: String, keyByte: UInt8) -> Computer {
    let key = Data(repeating: keyByte, count: 32)
    let encoded = key.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return Computer(id: RelayCrypto.computerId(signKey: key), name: name, signKey: encoded)
}

private final class Tokens: InviteTokenStore, @unchecked Sendable {
    var invites: [ComputerID: StoredInvite] = [:]
    func stored(for computer: ComputerID) -> StoredInvite? { invites[computer] }
    func keep(_ invite: StoredInvite, for computer: ComputerID) throws { invites[computer] = invite }
    func forget(_ computer: ComputerID) { invites[computer] = nil }
}

/// An account with the given computers, each in the connection asked for.
@MainActor private func account(_ computers: [(Computer, BotStore.Connection)], members: Set<ComputerID> = [],
                                suite: String) -> AccountStore {
    let storage = SharedStore.Context(accountID: "problem-user", suite: suite)
    storage.computers = computers.map(\.0)
    let tokens = Tokens()
    for id in members { tokens.invites[id] = StoredInvite(inviteId: "inv", token: String(repeating: "a", count: 43)) }
    let accounts = AccountStore(storage: storage, cloud: nil, inviteTokens: tokens) { computer in
        BotStore(computer: computer, storage: storage) { FakeRemote(.connecting) }
    }
    accounts.setActive(false)
    for (computer, connection) in computers { accounts.store(for: computer.id)?.connection = connection }
    return accounts
}

private func withSuite<T>(_ body: (String) throws -> T) rethrows -> T {
    let suite = "ComputerProblemTests.\(UUID().uuidString)"
    defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
    return try body(suite)
}

@MainActor @Test func offlineUnreachableAndUnauthorizedShowACard() {
    withSuite { suite in
        let a = mac("A", keyByte: 1), b = mac("B", keyByte: 2), c = mac("C", keyByte: 3)
        let seen = Date(timeIntervalSince1970: 1_000)
        let accounts = account([(a, .computerOffline(lastSeen: seen)), (b, .offline("no route")), (c, .unauthorized("Access was removed."))],
                               suite: suite)
        defer { accounts.retire() }
        let problems = ComputerProblem.all(in: accounts, hidden: "")
        #expect(problems.map(\.id) == [a.id, b.id, c.id])
        #expect(problems[0].kind == .offline(lastSeen: seen))
        #expect(problems[1].kind == .unreachable)
        #expect(problems[2].kind == .unauthorized(message: "Access was removed."))
        #expect(problems.allSatisfy { $0.hasPage })
    }
}

@MainActor @Test func connectingOnlineAndUnpairedShowNoCard() {
    withSuite { suite in
        let accounts = account([(mac("A", keyByte: 1), .connecting), (mac("B", keyByte: 2), .online), (mac("C", keyByte: 3), .unpaired)],
                               suite: suite)
        defer { accounts.retire() }
        #expect(ComputerProblem.all(in: accounts, hidden: "").isEmpty)
    }
}

@MainActor @Test func aVersionMismatchNeverShowsAProblemCard() {
    withSuite { suite in
        let a = mac("A", keyByte: 1)
        let accounts = account([(a, .computerOffline(lastSeen: nil))], suite: suite)
        defer { accounts.retire() }
        #expect(ComputerProblem.all(in: accounts, hidden: "").count == 1)
        // A host from before protocol levels, older than this app needs: the update card's case.
        accounts.store(for: a.id)?.hostVersion = HostVersion(version: "2.11.1")
        #expect(accounts.store(for: a.id)?.mismatch != nil)
        #expect(ComputerProblem.all(in: accounts, hidden: "").isEmpty)
    }
}

@MainActor @Test func aComputerHiddenFromCrewShowsNoCard() {
    withSuite { suite in
        let a = mac("A", keyByte: 1), b = mac("B", keyByte: 2)
        let accounts = account([(a, .offline("x")), (b, .offline("y"))], suite: suite)
        defer { accounts.retire() }
        let problems = ComputerProblem.all(in: accounts, hidden: a.id)
        #expect(problems.map(\.id) == [b.id])
        #expect(ComputerProblem.healthLine(in: accounts, hidden: a.id) == "1 Mac · 1 offline")
    }
}

@MainActor @Test func anOlderCopyOfAnOfflineMacShowsNoCardButAnUnauthorizedOneDoes() {
    withSuite { suite in
        let old = mac("Studio", keyByte: 1), current = mac("Studio", keyByte: 2), turnedAway = mac("Mini", keyByte: 3)
        let accounts = account([(old, .offline("x")), (current, .online), (turnedAway, .unauthorized("Revoked"))], suite: suite)
        defer { accounts.retire() }
        #expect(accounts.isStale(old.id))
        #expect(ComputerProblem.all(in: accounts, hidden: "").map(\.id) == [turnedAway.id])
    }
}

@MainActor @Test func aMemberComputerGetsACardWithoutAPage() {
    withSuite { suite in
        let a = mac("A", keyByte: 1), joined = mac("Mia's", keyByte: 2)
        let accounts = account([(a, .online), (joined, .offline("x"))], members: [joined.id], suite: suite)
        defer { accounts.retire() }
        let problems = ComputerProblem.all(in: accounts, hidden: "")
        #expect(problems.map(\.id) == [joined.id])
        #expect(problems.first?.hasPage == false)
    }
}

@MainActor @Test func healthLineCountsShownMacs() {
    withSuite { suite in
        let a = mac("A", keyByte: 1), b = mac("B", keyByte: 2), c = mac("C", keyByte: 3)
        let empty = account([], suite: suite)
        defer { empty.retire() }
        #expect(ComputerProblem.healthLine(in: empty, hidden: "") == "No Macs yet")
        let healthy = account([(a, .online), (b, .connecting)], suite: suite)
        defer { healthy.retire() }
        #expect(ComputerProblem.healthLine(in: healthy, hidden: "") == "2 Macs · all running")
        let offline = account([(a, .online), (b, .offline("x")), (c, .computerOffline(lastSeen: nil))], suite: suite)
        defer { offline.retire() }
        #expect(ComputerProblem.healthLine(in: offline, hidden: "") == "3 Macs · 2 offline")
        let mixed = account([(a, .online), (b, .offline("x")), (c, .unauthorized("no"))], suite: suite)
        defer { mixed.retire() }
        #expect(ComputerProblem.healthLine(in: mixed, hidden: "") == "3 Macs · 2 need a look")
    }
}
