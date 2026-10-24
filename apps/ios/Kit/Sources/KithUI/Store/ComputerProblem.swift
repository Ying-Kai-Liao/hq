import Foundation
import KithKit

/// A computer that needs the person: offline, out of reach, or turning this iPhone away. Settings
/// shows one card per problem (docs/design: Account + Settings). It clears itself when the
/// connection changes; there is nothing to dismiss.
public struct ComputerProblem: Equatable, Identifiable, Sendable {
    public enum Kind: Equatable, Sendable {
        case offline(lastSeen: Date?)
        case unreachable
        case unauthorized(message: String)
    }

    /// The computer's ID: a computer in both the owned and the account lists is still one card.
    public let id: ComputerID
    public let name: String
    public let kind: Kind
    /// A computer joined by invite has no page to open.
    public let hasPage: Bool

    public init(id: ComputerID, name: String, kind: Kind, hasPage: Bool) {
        self.id = id
        self.name = name
        self.kind = kind
        self.hasPage = hasPage
    }

    /// Whether a single computer is in trouble. A version mismatch is the update card's, never this one;
    /// "connecting" is Crew's "catching up"; an older copy of an offline Mac is cleaned up, not reconnected.
    /// `AccountStore.isStale` is always true for an unauthorized computer, so it only gates the offline kinds:
    /// the unauthorized card's Pair again is the fix for those.
    @MainActor public init?(store: BotStore, isStale: Bool, hasPage: Bool) {
        guard store.mismatch == nil else { return nil }
        let kind: Kind
        switch store.connection {
        case let .computerOffline(lastSeen): kind = .offline(lastSeen: lastSeen)
        case .offline: kind = .unreachable
        case let .unauthorized(message): kind = .unauthorized(message: message)
        case .online, .connecting, .unpaired: return nil
        }
        if isStale { guard case .unauthorized = kind else { return nil } }
        self.init(id: store.computer.id, name: store.hostName, kind: kind, hasPage: hasPage)
    }

    /// Problems of the computers shown in Crew, in computer order.
    @MainActor public static func all(in accounts: AccountStore, hidden: String) -> [ComputerProblem] {
        let shown = Set(ComputerSelection(all: accounts.computers.map(\.id), hidden: hidden).shown)
        var seen = Set<ComputerID>()
        return accounts.computers.compactMap { computer in
            guard shown.contains(computer.id), seen.insert(computer.id).inserted,
                  let store = accounts.store(for: computer.id) else { return nil }
            return ComputerProblem(store: store, isStale: accounts.isStale(computer.id),
                                   hasPage: accounts.role(for: computer.id) != .member)
        }
    }

    /// The health line under the account row, over shown computers: "3 Macs · 1 offline".
    @MainActor public static func healthLine(in accounts: AccountStore, hidden: String) -> String {
        let shown = Set(ComputerSelection(all: accounts.computers.map(\.id), hidden: hidden).shown)
        let count = accounts.computers.filter { shown.contains($0.id) }.count
        guard count > 0 else { return "No Macs yet" }
        let problems = all(in: accounts, hidden: hidden)
        let noun = count == 1 ? "1 Mac" : "\(count) Macs"
        if problems.isEmpty { return "\(noun) · all running" }
        let allOffline = problems.allSatisfy { if case .unauthorized = $0.kind { false } else { true } }
        return "\(noun) · \(problems.count) \(allOffline ? "offline" : "need a look")"
    }
}
