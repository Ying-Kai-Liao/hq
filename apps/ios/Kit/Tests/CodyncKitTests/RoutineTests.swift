import Foundation
import Testing
@testable import CodyncKit

@Test func routinesDecodeMixedTriggersAndRunHistory() throws {
    let data = Data(#"{"routines":[{"id":"r","botId":"b","name":"Check","instruction":"Check status","triggers":[{"type":"cron","expression":"20 14 * * 0","timeZone":"Asia/Taipei"},{"type":"webhook"}],"enabled":true,"createdAt":0,"updatedAt":0,"triggerDescriptions":["Every Sunday","When a webhook fires"],"nextRunAt":1000}],"runs":[{"id":"run","routineId":"r","botId":"b","status":"pending","createdAt":0,"event":{"source":"schedule"}}]}"#.utf8)
    let listing = try JSONDecoder().decode(RoutineListing.self, from: data)
    #expect(listing.routines[0].triggers[0].timeZone == "Asia/Taipei")
    #expect(listing.routines[0].triggers[1].type == "webhook")
    #expect(listing.runs[0].isActive)
    #expect(listing.runs[0].rootId == nil)
}

@Test func routineTranscriptLinkSurvivesRoundTrip() throws {
    let data = Data(#"{"text":"Created routine","routineId":"r","runId":"run","style":"info"}"#.utf8)
    let entry = try JSONDecoder().decode(EntryData.self, from: data)
    let restored = try JSONDecoder().decode(EntryData.self, from: JSONEncoder().encode(entry))
    #expect(restored.routineId == "r")
    #expect(restored.runId == "run")
}

@Test func routineScheduleResponseCarriesServerPreviewWithoutClientRules() throws {
    let data = Data(#"{"draft":{"kind":"cron","amount":"1","unit":3600,"calendarStyle":"days","weekday":1,"selectedDays":[1,3,5],"monthDay":1,"minuteStep":15,"hour":23,"minute":47,"at":0,"expression":"47 23 * * 1,3,5","zone":"Asia/Taipei","original":[]},"triggers":[{"type":"cron","expression":"47 23 * * 1,3,5","timeZone":"Asia/Taipei"}],"summary":"Server schedule description","nextRunAt":1790470800000,"warning":null}"#.utf8)
    let preview = try JSONDecoder().decode(RoutineSchedulePreview.self, from: data)
    #expect(preview.summary == "Server schedule description")
    #expect(preview.draft.selectedDays == [1, 3, 5])
    #expect(preview.nextRunAt == 1_790_470_800_000)
    let encoded = try JSONEncoder().encode(preview.draft)
    #expect(try JSONDecoder().decode(RoutineScheduleDraft.self, from: encoded) == preview.draft)
}

@Test func routineDateControlPreservesWireMilliseconds() {
    var draft = RoutineScheduleDraft()
    draft.at = 1_779_000_000_001
    let date = draft.date
    draft.date = date
    #expect(draft.at == 1_779_000_000_001)
}

@Test func routineWebhookDecodesWithAndWithoutTheCloud() throws {
    let cloud = Data(#"{"url":"https://api.codync.dev/v1/hooks/c/r","localUrl":"http://127.0.0.1:19222/hooks/routines/r","key":"k","connected":true}"#.utf8)
    let local = Data(#"{"url":null,"localUrl":"http://127.0.0.1:19222/hooks/routines/r","key":"k","connected":false}"#.utf8)
    #expect(try JSONDecoder().decode(RoutineWebhook.self, from: cloud).url == "https://api.codync.dev/v1/hooks/c/r")
    let off = try JSONDecoder().decode(RoutineWebhook.self, from: local)
    #expect(off.url == nil)
    #expect(off.localUrl.hasSuffix("/hooks/routines/r"))
}
