import Foundation

/// How Crew orders rooms below the pinned ones (Settings > Crew order).
public enum CrewOrderMode: String, CaseIterable, Sendable {
    /// Needs you, then working, then recent. The stored manual order breaks ties.
    case automatic
    /// Your drag order for everything, synced to the host exactly as before.
    case manual

    public static let storageKey = "crewOrder"

    public var label: String { self == .automatic ? "Automatic" : "Manual" }

    public init(stored: String) { self = CrewOrderMode(rawValue: stored) ?? .automatic }
}

/// What the ordering needs to know about one room.
public struct CrewOrderItem: Equatable, Sendable {
    public var id: String
    /// Where the room's computer sits in the computer order kept on this device.
    public var computer: Int
    public var pinned: Bool
    /// The stored manual order (the host's `position`).
    public var position: Int
    public var lastAt: Int64
    public var needsYou: Bool
    public var working: Bool

    public init(id: String, computer: Int = 0, pinned: Bool, position: Int, lastAt: Int64, needsYou: Bool = false, working: Bool = false) {
        self.id = id
        self.computer = computer
        self.pinned = pinned
        self.position = position
        self.lastAt = lastAt
        self.needsYou = needsYou
        self.working = working
    }
}

public enum CrewOrder {
    /// Room ids in display order. Pinned rooms are always first, in the user's own order (position, then recent).
    /// Automatic puts the rest by need (needs you, working, recent) and uses the stored position only to break ties.
    public static func sorted(_ items: [CrewOrderItem], mode: CrewOrderMode) -> [String] {
        items.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            if a.pinned || mode == .manual { return manual(a, b) }
            let (ba, bb) = (bucket(a), bucket(b))
            if ba != bb { return ba < bb }
            if a.lastAt != b.lastAt { return a.lastAt > b.lastAt }
            return manual(a, b)
        }.map(\.id)
    }

    private static func bucket(_ item: CrewOrderItem) -> Int { item.needsYou ? 0 : item.working ? 1 : 2 }

    /// Computers in their stored order, then each computer's own order: positions are per computer, so interleaving
    /// two computers' rooms by position would put a dropped room where it can't be written.
    private static func manual(_ a: CrewOrderItem, _ b: CrewOrderItem) -> Bool {
        if a.computer != b.computer { return a.computer < b.computer }
        if a.position != b.position { return a.position < b.position }
        if a.lastAt != b.lastAt { return a.lastAt > b.lastAt }
        return a.id < b.id
    }

    /// Whether dragging (and Move up / Move down) is offered for a room: always on pinned rooms, on every room in Manual.
    public static func canReorder(pinned: Bool, mode: CrewOrderMode) -> Bool { pinned || mode == .manual }
}

/// Holds the list still while a finger is on it: while `frozen`, rooms keep the order they were shown in (rooms that
/// are gone drop out, new ones go last); once it lets go, the computed order is adopted.
public struct CrewOrderHold: Equatable, Sendable {
    public private(set) var shown: [String] = []

    public init() {}

    /// What to show now, without remembering it (a view body reads this).
    public func resolved(computed: [String], frozen: Bool) -> [String] {
        guard frozen, !shown.isEmpty else { return computed }
        let alive = Set(computed)
        let kept = shown.filter(alive.contains)
        let keptSet = Set(kept)
        return kept + computed.filter { !keptSet.contains($0) }
    }

    /// Remembers what is shown; call when the computed order or `frozen` changes.
    @discardableResult
    public mutating func update(computed: [String], frozen: Bool) -> [String] {
        shown = resolved(computed: computed, frozen: frozen)
        return shown
    }
}

/// What the dock's box searches: one room's names and status.
public struct CrewSearchEntry: Equatable, Sendable {
    public var id: String
    public var name: String
    /// The person a team room is shared with, or a group's member names.
    public var people: [String]
    public var status: String
    /// Folder, harness and the like: matched last.
    public var extras: [String]

    public init(id: String, name: String, people: [String] = [], status: String = "", extras: [String] = []) {
        self.id = id
        self.name = name
        self.people = people
        self.status = status
        self.extras = extras
    }
}

public enum CrewSearch {
    /// Ids of the rooms matching `query`, best first. Every word of the query must match somewhere. A name beats a
    /// person, which beats the status line, which beats the rest; at equal rank the list keeps the order it came in.
    public static func rank(_ entries: [CrewSearchEntry], query: String) -> [String] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return entries.map(\.id) }
        let scored = entries.enumerated().compactMap { index, entry -> (Int, Int, String)? in
            var total = 0
            for word in words {
                let score = score(word, in: entry)
                if score == 0 { return nil }
                total += score
            }
            return (total, index, entry.id)
        }
        return scored.sorted { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1 < $1.1 }.map(\.2)
    }

    private static func score(_ word: String, in entry: CrewSearchEntry) -> Int {
        var best = textScore(word, entry.name) * 10
        for person in entry.people { best = max(best, textScore(word, person) * 6) }
        best = max(best, textScore(word, entry.status) * 3)
        for extra in entry.extras { best = max(best, textScore(word, extra)) }
        return best
    }

    /// 3 a name that starts with it, 2 a word that does, 1 contains it, 0 no match.
    private static func textScore(_ word: String, _ text: String) -> Int {
        let text = text.lowercased()
        if text.hasPrefix(word) { return 3 }
        if text.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(word) }) { return 2 }
        return text.contains(word) ? 1 : 0
    }
}
