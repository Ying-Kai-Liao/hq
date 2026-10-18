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
            // A host before 2.18.0 answers with its old memory listing, which has no layers or dreams.
            if asked == request {
                self.error = error is DecodingError ? "Update Codync on your computer to see this bot's memory." : error.localizedDescription
            }
        }
    }

    /// A long-form file as it is now, with its versions.
    func file(_ name: String, shared: Bool) async -> MemoryFileDetail? {
        do {
            return try await client().memoryFile(botId: botId, file: name, shared: shared)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    /// Saves, deletes (`content` and `version` nil) or brings back a version of a file over what was loaded (`base`);
    /// reloads after it.
    @discardableResult
    func changeFile(_ name: String, shared: Bool, base: String?, content: String? = nil, version: Int64? = nil) async -> Bool {
        guard !busy else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await client().changeMemoryFile(botId: botId, file: name, shared: shared, base: base, content: content, version: version)
            await load()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
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
