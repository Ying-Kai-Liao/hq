import Foundation
import Testing
@testable import CodyncKit

@Test func activityErrorAndUnknownStatusNeverLookCompleted() {
    let error = BotActivityPresentation(status: "error", activity: "")
    #expect(error.phase == .failed)
    #expect(error.title == "Failed")
    #expect(error.symbol != "checkmark")
    let unknown = BotActivityPresentation(status: "new-host-status", activity: "")
    #expect(unknown.phase == .waiting)
    #expect(unknown.symbol != "checkmark")
}

@Test func staleActivityStopsPresentingLiveProgress() {
    for status in ["working", "needsInput"] {
        let stale = BotActivityPresentation(status: status, activity: "Old step", isStale: true)
        #expect(stale.phase == .stale)
        #expect(!stale.caption.contains("Old step"))
    }
    let done = BotActivityPresentation(status: "idle", activity: "Old step", isStale: true)
    #expect(done.phase == .completed)
    #expect(done.symbol == "checkmark")
}

@Test func activityCaptionIsTheStepWhileLive() {
    #expect(BotActivityPresentation(status: "needsInput", activity: "Choose a branch").caption == "Choose a branch")
    #expect(BotActivityPresentation(status: "working", activity: "").caption == "Working")
    #expect(BotActivityPresentation(status: "idle", activity: "Old step").caption == "Done")
}
