import CodyncKit
import Foundation
import Observation

/// An hq agent's memory as the host serves it: the files, their history and the tidy-ups.
/// Every call that writes sets `busy`, so a double tap can't send twice.
@MainActor @Observable
final class HqMemoryStore {
    let botId: String
    private let client: () async throws -> HostClient
    var list: HqMemoryList?
    var tidyUps: [HqTidyUp]?
    /// Why the lists couldn't be read (the agent folder is gone, an older host, no connection).
    var error: String?
    var busy = false
    /// What the last undo left alone, by tidy-up id.
    var refusals: [Int64: [HqTidyUndo.Refusal]] = [:]
    private var request = 0

    init(botId: String, client: @escaping () async throws -> HostClient) {
        self.botId = botId
        self.client = client
    }

    func load() async {
        request += 1
        let asked = request
        do {
            let host = try await client()
            let files = try await host.hqMemoryList(botId: botId)
            let runs = try await host.hqTidyUps(botId: botId)
            guard asked == request else { return }
            list = files
            tidyUps = runs
            error = nil
        } catch {
            guard asked == request else { return }
            self.error = error.localizedDescription
        }
    }

    func read(shared: Bool, name: String) async throws -> HqMemoryText {
        try await client().hqMemoryRead(botId: botId, shared: shared, name: name)
    }

    func history(shared: Bool, name: String) async throws -> [HqMemoryVersion] {
        try await client().hqMemoryHistory(botId: botId, shared: shared, name: name).versions
    }

    func diff(shared: Bool, name: String, from: Int64?, to: Int64) async throws -> String {
        try await client().hqMemoryDiff(botId: botId, shared: shared, name: name, from: from, to: to).diff
    }

    /// Runs a write; nil when another is pending or it fails (then `error` says why).
    private func write<T>(_ work: (HostClient) async throws -> T) async -> T? {
        guard !busy else { return nil }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let value = try await work(try await client())
            await load()
            return value
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    func save(shared: Bool, name: String, text: String) async -> HqMemoryWrite? {
        await write { try await $0.hqMemorySave(botId: botId, shared: shared, name: name, text: text) }
    }

    func restore(shared: Bool, name: String, version: Int64) async -> HqMemoryWrite? {
        await write { try await $0.hqMemoryRestore(botId: botId, shared: shared, name: name, version: version) }
    }

    @discardableResult
    func undoTidy(_ run: HqTidyUp) async -> HqTidyUndo? {
        let result = await write { try await $0.hqUndoTidy(botId: botId, id: run.id) }
        if let result { refusals[run.id] = result.refused }
        return result
    }
}
