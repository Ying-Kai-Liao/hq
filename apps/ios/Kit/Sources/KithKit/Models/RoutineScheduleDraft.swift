import Foundation

/// Form values only. The host hydrates, compiles, validates and describes schedules.
public struct RoutineScheduleDraft: Codable, Hashable, Sendable {
    public var kind = "cron"
    public var amount = "1"
    public var unit: Int64 = 3600
    public var calendarStyle = "daily"
    public var weekday = 1
    public var selectedDays: Set<Int> = []
    public var monthDay = 1
    public var minuteStep = 15
    public var hour = 9
    public var minute = 0
    public var at: Int64 = 0
    public var expression = ""
    public var zone = ""
    public var original: [RoutineTrigger] = []

    public init() {}

    /// DatePicker's Date is converted only for wire encoding; no scheduling is done here.
    public var date: Date {
        get { Date(timeIntervalSince1970: Double(at) / 1000) }
        set { at = Int64((newValue.timeIntervalSince1970 * 1000).rounded()) }
    }
}

public struct RoutineSchedulePreview: Codable, Sendable {
    public var draft: RoutineScheduleDraft
    public var triggers: [RoutineTrigger]
    public var summary: String
    public var nextRunAt: Int64?
    public var warning: String?
}

extension HostClient {
    public func routineSchedule(triggers: [RoutineTrigger], timeZone: String) async throws -> RoutineSchedulePreview {
        struct Body: Encodable { let triggers: [RoutineTrigger]; let timeZone: String }
        return try await call("routineSchedule", Body(triggers: triggers, timeZone: timeZone))
    }

    public func routineSchedule(draft: RoutineScheduleDraft) async throws -> RoutineSchedulePreview {
        struct Body: Encodable { let draft: RoutineScheduleDraft }
        return try await call("routineSchedule", Body(draft: draft))
    }

    public func saveRoutine(botId: String, id: String?, name: String, instruction: String,
                            schedule: RoutineScheduleDraft, timeoutSeconds: String) async throws -> Routine {
        struct Body: Encodable {
            let botId: String
            let id: String?
            let name: String
            let instruction: String
            let schedule: RoutineScheduleDraft
            let timeoutSeconds: String
        }
        struct Response: Decodable { let routine: Routine }
        let response: Response = try await call("saveRoutine", Body(botId: botId, id: id, name: name,
            instruction: instruction, schedule: schedule, timeoutSeconds: timeoutSeconds))
        return response.routine
    }
}
