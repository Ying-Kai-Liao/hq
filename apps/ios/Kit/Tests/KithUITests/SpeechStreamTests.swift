@testable import KithUI
import Foundation
import Testing

// Kith voice's live speech: ported from the desktop's speech-stream and speech-clips tests.

@Test func sentenceEndIgnoresDotsInNumbersAndFileNames() {
    #expect(SentenceBounds.end("Version 3.5 is out") == 0)
    #expect(SentenceBounds.end("Open a.ts now") == 0)
    #expect(SentenceBounds.end("One. Two") == 4)
    #expect(SentenceBounds.end("Done!") == 0) // at the very end: the next update confirms it
    #expect(SentenceBounds.end("你好。再") == 3)
}

@Test func aGrowingReplyIsSpokenOneFinishedSentenceAtATime() {
    var s = SentenceStream()
    #expect(s.feed("a", "Hel", final: false) == "")
    #expect(s.feed("a", "Hello there. I am", final: false) == "Hello there.")
    #expect(s.feed("a", "Hello there. I am here. Next", final: false) == "I am here.")
    #expect(s.feed("a", "Hello there. I am here. Next", final: false) == "")
    #expect(s.isOpen)
    #expect(s.feed("a", "Hello there. I am here. Next one", final: true) == "Next one")
    #expect(!s.isOpen)
    #expect(s.feed("a", "Hello there. I am here. Next one", final: true) == "")
}

@Test func codeBlocksAndMarkdownAreNotSpokenWhileStreaming() {
    var s = SentenceStream()
    #expect(s.feed("a", "Run this. \n```sh\nls -la. \n", final: false) == "Run this.")
    #expect(s.feed("a", "Run this. \n```sh\nls -la. \n```\nThen **wait** for it. Ok", final: false) == "Then wait for it.")
}

@Test func aRewriteOfSpokenTextWaitsForTheEndAndSaysOnlyTheSentencesAfterIt() {
    var s = SentenceStream()
    #expect(s.feed("a", "First sentence. Second", final: false) == "First sentence.")
    #expect(s.feed("a", "Changed sentence. Second one. Third", final: false) == "")
    #expect(s.feed("a", "Changed sentence. Second one. Third.", final: true) == "Second one. Third.")
}

@Test func mutingOpenRepliesStopsTheirSpeechButNotALaterReply() {
    var s = SentenceStream()
    #expect(s.feed("a", "One. Two", final: false) == "One.")
    s.muteOpen()
    #expect(!s.isOpen)
    #expect(s.feed("a", "One. Two. Three. x", final: false) == "")
    #expect(s.feed("a", "One. Two. Three. x", final: true) == "")
    #expect(s.feed("b", "Fresh reply.", final: true) == "Fresh reply.")
}

@Test func anEntryFirstSeenFinalIsSpokenWhole() {
    var s = SentenceStream()
    #expect(s.feed("a", "All of it", final: true) == "All of it")
}

@Test func wordCountCountsCJKCharactersAsHalf() {
    #expect(SpeechEcho.wordCount("hello there") == 2)
    #expect(SpeechEcho.wordCount("stop") == 1)
    #expect(SpeechEcho.wordCount("你好") == 1)
    #expect(SpeechEcho.wordCount("你好嗎今天") == 2.5)
}

private let spoken = "The build finished without errors. Three tests were skipped because they need a network connection."

@Test func isEchoMatchesTheSpokenTextAlsoWithAMisheardWord() {
    #expect(SpeechEcho.isEcho("the build finished without errors", spoken: spoken))
    #expect(SpeechEcho.isEcho("three tests were skipped because they need a network", spoken: spoken))
    #expect(SpeechEcho.isEcho("three tests were skipped because they meet a network connection", spoken: spoken))
    #expect(!SpeechEcho.isEcho("the build finished with errors", spoken: spoken))
    #expect(!SpeechEcho.isEcho("wait stop that", spoken: spoken))
    #expect(SpeechEcho.isEcho("", spoken: spoken))
}

@Test func stripEchoDropsTheBotWordsFromTheStartOfTheRunningTranscript() {
    #expect(SpeechEcho.stripEcho("the build finished without errors what about the lint", spoken: spoken) == "what about the lint")
    #expect(SpeechEcho.stripEcho("the build finished without errors", spoken: spoken) == "")
    #expect(SpeechEcho.stripEcho("what about the lint", spoken: spoken) == "what about the lint")
    // two copied words aren't enough to be sure
    #expect(SpeechEcho.stripEcho("the build please", spoken: spoken) == "the build please")
    #expect(SpeechEcho.stripEcho("anything", spoken: "") == "anything")
}

@Test func shouldCueFiresOnceOnlyWhileWorkingAndSilent() {
    let sent = Date(timeIntervalSince1970: 1000)
    let now = sent.addingTimeInterval(5)
    let never = Date.distantPast
    #expect(SpeechCue.shouldCue(now: now, sentAt: sent, lastSpokenAt: never, working: true, cued: false))
    #expect(!SpeechCue.shouldCue(now: now.addingTimeInterval(-0.1), sentAt: sent, lastSpokenAt: never, working: true, cued: false))
    #expect(!SpeechCue.shouldCue(now: now, sentAt: sent, lastSpokenAt: never, working: true, cued: true))
    #expect(!SpeechCue.shouldCue(now: now, sentAt: sent, lastSpokenAt: never, working: false, cued: false))
    #expect(!SpeechCue.shouldCue(now: now, sentAt: sent, lastSpokenAt: sent.addingTimeInterval(2), working: true, cued: false))
    #expect(!SpeechCue.shouldCue(now: now, sentAt: nil, lastSpokenAt: never, working: true, cued: false))
}

@MainActor @Test func clipQueuePrefetchesTheNextClipOnceOneIsHandedOut() async {
    var asked: [String] = []
    let q = ClipQueue<String> { asked.append($0); return $0.uppercased() }
    q.add(["a", "b", "c"])
    #expect(await q.take() == "A")
    for _ in 0..<5 { await Task.yield() }
    #expect(asked == ["a", "b"])
    #expect(await q.take() == "B")
    #expect(await q.take() == "C")
    #expect(await q.take() == nil)
    #expect(!q.pending)
}

@MainActor @Test func clipQueueDropsAClipThatArrivesAfterStop() async {
    let gate = AsyncStream<Void>.makeStream()
    let q = ClipQueue<String> { _ in
        for await _ in gate.stream { break }
        return "late"
    }
    q.add(["a", "b"])
    async let taken = q.take()
    await Task.yield()
    q.stop()
    gate.continuation.yield()
    #expect(await taken == nil)
    #expect(!q.pending)
    // A new reply after the stop starts clean.
    let fresh = ClipQueue<String> { $0 }
    fresh.add(["x"])
    #expect(await fresh.take() == "x")
}

@MainActor @Test func clipQueueEndsOnAClipThatFailed() async {
    let q = ClipQueue<String> { _ in nil }
    q.add(["a", "b"])
    #expect(await q.take() == nil)
}

@Test func onDeviceTranscriptDropsTheBotsGreetingButKeepsTheUsersWords() {
    let greeting = "Hello, what can I do for you today?"
    // the exact case from the house session: the greeting comes back, then the user speaks
    #expect(SpeechEcho.stripEcho("Hello, what can I do for you today? check what's expiring", spoken: greeting) == "check what's expiring")
    #expect(SpeechEcho.stripEcho("Hello what can I do for you today", spoken: greeting) == "")
    // fewer than three words in a row from the bot is the user's own
    #expect(SpeechEcho.stripEcho("yes check the pantry", spoken: "Should I check the pantry or the fridge?") == "yes check the pantry")
}

@Test func rememberKeepsOnlyTheLatestWindow() {
    let long = String(repeating: "word ", count: 400)
    let kept = SpeechEcho.remember("old", adding: long)
    #expect(kept.count == SpeechEcho.windowChars)
    #expect(SpeechEcho.remember("", adding: "hi").hasSuffix("hi"))
}
