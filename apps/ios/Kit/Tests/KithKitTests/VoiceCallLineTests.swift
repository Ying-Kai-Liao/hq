import Foundation
import Testing
@testable import KithKit

@Suite("Voice call line")
struct VoiceCallLineTests {
    private let now = Date(timeIntervalSince1970: 100_000)

    private func data(_ json: String) throws -> EntryData {
        try JSONDecoder().decode(EntryData.self, from: Data(json.utf8))
    }

    @Test func aFinishedCallShowsItsLength() throws {
        let d = try data(#"{"text":"Voice chat","callSeconds":76}"#)
        #expect(VoiceCallLine.suffix(d, at: now) == " · 01:16")
    }

    @Test func aLiveCallIsInProgressUntilItGoesStale() throws {
        let d = try data(#"{"text":"Voice chat","callLive":true}"#)
        #expect(VoiceCallLine.suffix(d, at: now.addingTimeInterval(-60), now: now) == " · in progress")
        #expect(VoiceCallLine.suffix(d, at: now.addingTimeInterval(-4 * 3600), now: now) == "")
    }

    @Test func otherNoticesAreNotCalls() throws {
        #expect(VoiceCallLine.suffix(try data(#"{"text":"hi"}"#), at: now) == nil)
    }
}
