import CodyncKit
import Foundation
import Observation

/// One bot's memory: fetches it, and changes it through the host.
@MainActor @Observable
final class MemoryStore {
    let botId: String
    private let client: () async throws -> HostClient
    var view: MemoryView?
    var busy = false
    var error: String?
    private var request = 0

    init(botId: String, client: @escaping () async throws -> HostClient) {
        self.botId = botId
        self.client = client
    }

    func load() async {
        request += 1
        let asked = request
        do {
            let value = try await client().memory(botId: botId)
            if asked == request {
                view = value
                error = nil
            }
        } catch {
            if asked == request { self.error = error.localizedDescription }
        }
    }

    /// A memory method for this bot; reloads after it.
    @discardableResult
    func mutate(_ method: String, id: Int64? = nil, pinned: Bool? = nil, archived: Bool? = nil, shared: Bool? = nil,
                text: String? = nil) async -> Bool {
        guard !busy else { return false }
        struct Body: Encodable {
            var botId: String; var id: Int64?; var pinned: Bool?; var archived: Bool?; var shared: Bool?; var text: String?
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await client().memoryCall(method, Body(botId: botId, id: id, pinned: pinned, archived: archived, shared: shared, text: text))
            await load()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
