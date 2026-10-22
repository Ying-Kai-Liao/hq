import Foundation

public struct Routine: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var botId: String
    public var name: String
    public var instruction: String
    public var triggers: [RoutineTrigger]
    public var enabled: Bool
    public var createdAt: Int64
    public var updatedAt: Int64
    public var triggerDescriptions: [String]
    public var nextRunAt: Int64?
    public var timeoutSeconds: Int?
    public var lastError: String?
}

public struct RoutineTrigger: Codable, Hashable, Sendable {
    public var type: String
    public var seconds: Int64?
    public var at: Int64?
    public var expression: String?
    public var timeZone: String?
    public var source: String?
    public var event: String?
    public var filters: [String: String]?

    public init(type: String, seconds: Int64? = nil, at: Int64? = nil, expression: String? = nil, timeZone: String? = nil) {
        self.type = type
        self.seconds = seconds
        self.at = at
        self.expression = expression
        self.timeZone = timeZone
    }
}

public struct RoutineRun: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var routineId: String
    public var botId: String
    public var status: String
    public var createdAt: Int64
    public var finishedAt: Int64?
    public var detail: String?
    public var rootId: String?
    public var isActive: Bool { ["pending", "starting", "running", "recovering"].contains(status) }
}

public struct RoutineListing: Codable, Sendable {
    public var routines: [Routine]
    public var runs: [RoutineRun]
}

/// A routine's webhook: `url` is public through the Codync cloud (nil while the cloud is off),
/// `localUrl` works on the host itself.
public struct RoutineWebhook: Codable, Sendable, Equatable {
    public var url: String?
    public var localUrl: String
    public var key: String
    public var connected: Bool
}

extension HostClient {
    public func routines(botId: String) async throws -> RoutineListing {
        struct Body: Encodable { let botId: String }
        return try await call("routines", Body(botId: botId))
    }

    public func routineAction(_ method: String, botId: String, id: String, enabled: Bool? = nil) async throws {
        struct Body: Encodable { let botId: String; let id: String; let enabled: Bool? }
        let _: Empty = try await call(method, Body(botId: botId, id: id, enabled: enabled))
    }

    /// `rotate` replaces the key first; senders using the old one stop working.
    public func routineWebhook(botId: String, id: String, rotate: Bool = false) async throws -> RoutineWebhook {
        struct Body: Encodable { let botId: String; let id: String; let rotate: Bool }
        return try await call("routineWebhook", Body(botId: botId, id: id, rotate: rotate))
    }
}

extension HostClient {
    public func saveRoutine(botId: String, id: String?, name: String, instruction: String,
                            triggers: [RoutineTrigger], timeoutSeconds: Int) async throws -> Routine {
        struct Body: Encodable {
            let botId: String
            let id: String?
            let name: String
            let instruction: String
            let triggers: [RoutineTrigger]
            let timeoutSeconds: Int
        }
        struct Response: Decodable { let routine: Routine }
        let response: Response = try await call("saveRoutine", Body(botId: botId, id: id, name: name,
            instruction: instruction, triggers: triggers, timeoutSeconds: timeoutSeconds))
        return response.routine
    }
}
