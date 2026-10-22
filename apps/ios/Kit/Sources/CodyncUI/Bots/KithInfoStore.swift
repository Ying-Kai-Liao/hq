import CodyncKit
import Foundation
import Observation

/// What a kith bot's detail page shows, fetched through the host (`kithInfo`, serve/docs/bot-info.md).
/// One store per opened details page: a `bot` event doesn't touch it, reopening fetches again, and there is no polling.
@MainActor @Observable
final class KithInfoStore {
    enum Phase {
        case loading
        case loaded(KithInfoResponse)
        /// The host has no `kithInfo` (an older one) or couldn't be reached: the kith sections stay hidden.
        case unavailable
    }

    let botId: String
    private let client: () async throws -> HostClient
    private(set) var phase: Phase = .loading
    private(set) var refreshing = false
    private var inflight: Task<Void, Never>?

    init(botId: String, client: @escaping () async throws -> HostClient) {
        self.botId = botId
        self.client = client
    }

    var info: KithInfo? {
        if case .loaded(let response) = phase { return response.info }
        return nil
    }

    /// Kith couldn't answer: shown as one banner with Retry.
    var failure: String? {
        if case .loaded(let response) = phase, response.info == nil { return response.error }
        return nil
    }

    var isLoading: Bool {
        if case .loading = phase { return true }
        return false
    }

    /// A second call while one runs (a double pull-to-refresh) waits for that one.
    func load(refresh: Bool = false) async {
        if let inflight {
            await inflight.value
            return
        }
        let botId = botId
        let task = Task { [client] in
            refreshing = true
            defer { refreshing = false }
            do {
                phase = .loaded(try await client().kithInfo(botId: botId, refresh: refresh))
            } catch {
                // Keep what is on screen when a refresh fails; with nothing yet, hide the sections.
                if case .loaded = phase {} else { phase = .unavailable }
            }
        }
        inflight = task
        await task.value
        inflight = nil
    }

    func search(_ query: String) async throws -> KithSearchResult {
        try await client().kithMemorySearch(botId: botId, query: query, limit: 30)
    }

    func file(_ path: String) async throws -> KithMemoryFile {
        try await client().kithMemoryFile(botId: botId, path: path)
    }
}
