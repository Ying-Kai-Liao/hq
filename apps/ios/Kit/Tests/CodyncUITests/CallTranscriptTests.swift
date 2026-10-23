import Testing
@testable import CodyncUI

@Test func botSentencesJoinOneLinePerTurn() {
    var t = CallTranscript()
    t.you("  what's the weather ")
    t.bot("It is sunny.")
    t.bot(" Around 22 degrees. ")
    t.you("thanks")
    t.bot("Anytime.")
    #expect(t.lines.map(\.text) == ["what's the weather", "It is sunny. Around 22 degrees.", "thanks", "Anytime."])
    #expect(t.lines.map(\.speaker) == [.you, .bot, .you, .bot])
}

@Test func emptyTextIsIgnoredAndOldLinesScrollAway() {
    var t = CallTranscript()
    t.you("   ")
    t.bot("")
    #expect(t.lines.isEmpty)
    for i in 0..<(CallTranscript.limit + 5) { t.you("m\(i)") }
    #expect(t.lines.count == CallTranscript.limit)
    #expect(t.lines.last?.text == "m\(CallTranscript.limit + 4)")
}

@Test func statusTextFollowsPhase() {
    #expect(CallStatus.text(phase: nil, muted: false, working: false, warning: nil) == "Connecting…")
    #expect(CallStatus.text(phase: .starting, muted: false, working: false, warning: "Downloading voice…") == "Downloading voice…")
    #expect(CallStatus.text(phase: .listening, muted: true, working: true, warning: nil) == "Muted")
    #expect(CallStatus.text(phase: .listening, muted: false, working: true, warning: nil) == "Working…")
    #expect(CallStatus.text(phase: .speaking, muted: false, working: false, warning: nil) == "Speaking")
    #expect(CallStatus.text(phase: .failed("x"), muted: false, working: false, warning: nil) == "Can't listen")
}

@Test func clockFormats() {
    #expect(CallStatus.clock(7) == "0:07")
    #expect(CallStatus.clock(723) == "12:03")
    #expect(CallStatus.clock(3723) == "1:02:03")
}
