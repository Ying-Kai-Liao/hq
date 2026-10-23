import Foundation

// The backup chain: the accounts and providers Kith moves a bot's turns to when its own account runs out of usage,
// as the host's `backups` answers (serve/host/src/api/backups.rs). This app only shows it; the order is edited on the
// computer, where logging in also happens. Decoded leniently: an entry of an odd shape drops out alone.

public struct BackupEntry: Decodable, Hashable, Sendable, Identifiable {
    /// `claude`, `claude:work`, `claude-api:main`, `codex`, `codex:deep`.
    public var id: String
    public var ready: Bool
    /// Why it isn't ready.
    public var why: String?
    /// The one command that makes it ready, run in the computer's terminal.
    public var fix: String?
    /// While it is out of usage: when it is back.
    public var outUntil: Date?
    /// `rate_limit` (the provider refused a turn) or `usage_95` (switched early).
    public var reason: String?

    public init(id: String, ready: Bool = true, why: String? = nil, fix: String? = nil, outUntil: Date? = nil, reason: String? = nil) {
        self.id = id
        self.ready = ready
        self.why = why
        self.fix = fix
        self.outUntil = outUntil
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case id, ready, why, fix, outUntil, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ready = (try? c.decode(Bool.self, forKey: .ready)) ?? false
        why = try? c.decodeIfPresent(String.self, forKey: .why)
        fix = try? c.decodeIfPresent(String.self, forKey: .fix)
        outUntil = (try? c.decodeIfPresent(Double.self, forKey: .outUntil)).map { Date(timeIntervalSince1970: $0 / 1000) }
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }

    public func isOut(now: Date = Date()) -> Bool { outUntil.map { $0 > now } ?? false }

    /// What the user needs to know: ready, out until a time, or why it can't run.
    public func state(now: Date = Date()) -> String {
        if let until = outUntil, until > now { return "out of usage, " + Self.backAt(until, now: now) }
        if !ready { return why ?? "not ready" }
        return "ready"
    }

    /// "back at 3:40 PM", with the day when it isn't today.
    static func backAt(_ date: Date, now: Date) -> String {
        let sameDay = Calendar.current.isDate(date, inSameDayAs: now)
        let text = sameDay
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return "back at \(text)"
    }
}

public struct Backups: Decodable, Sendable, Equatable {
    /// Entry ids, in order.
    public var global: [String]
    /// Only the agents with an order of their own.
    public var agents: [String: [String]]
    public var entries: [BackupEntry]

    public init(global: [String] = [], agents: [String: [String]] = [:], entries: [BackupEntry] = []) {
        self.global = global
        self.agents = agents
        self.entries = entries
    }

    private enum CodingKeys: String, CodingKey { case global, agents, entries }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        global = (try? c.decode([String].self, forKey: .global)) ?? []
        agents = (try? c.decode([String: [String]].self, forKey: .agents)) ?? [:]
        var out: [BackupEntry] = []
        if var items = try? c.nestedUnkeyedContainer(forKey: .entries) {
            while !items.isAtEnd {
                if let entry = try? items.decode(BackupEntry.self) { out.append(entry) } else { _ = try? items.decode(Skip.self) }
            }
        }
        entries = out
    }

    /// The entry for `id`; one the host didn't describe is shown as not ready.
    public func entry(_ id: String) -> BackupEntry {
        entries.first { $0.id == id } ?? BackupEntry(id: id, ready: false)
    }

    /// One line for the global order, e.g. "codex, claude:work".
    public var globalText: String { global.joined(separator: ", ") }
}

private struct Skip: Decodable { init(from decoder: Decoder) throws {} }

/// "via codex" under a reply a backup account answered; nil for the agent's own account and for older messages.
public func backupViaLabel(_ answeredBy: String?) -> String? {
    guard let answeredBy, !answeredBy.isEmpty else { return nil }
    return "via \(answeredBy)"
}
