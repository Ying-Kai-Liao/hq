@testable import CodyncUI
import Testing

/// Replies are read aloud in clips that each fit one channel message.
@MainActor @Test func speechClipsKeepSentencesUnderTheLimit() {
    let clips = CloudSpeechEngine.clips("第一句。第二句很長很長。Third one! " + String(repeating: "x", count: 25), limit: 10)
    #expect(clips.allSatisfy { $0.count <= 10 })
    #expect(clips.first == "第一句。")
    #expect(clips.joined().replacingOccurrences(of: " ", with: "") ==
        ("第一句。第二句很長很長。Third one! " + String(repeating: "x", count: 25)).replacingOccurrences(of: " ", with: ""))
    #expect(CloudSpeechEngine.clips("", limit: 10).isEmpty)
}
