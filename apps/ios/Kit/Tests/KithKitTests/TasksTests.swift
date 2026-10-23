import Foundation
import Testing
@testable import KithKit

private func entry(_ id: String, _ kind: String, thread: String? = nil, _ configure: (inout EntryData) -> Void = { _ in }) -> Entry {
    var data = EntryData()
    configure(&data)
    return Entry(id: id, seq: 0, botId: "b", threadId: thread, rev: 1, kind: kind, turn: 1, data: data, createdAt: 0, updatedAt: 0)
}

private func bot(_ json: String) throws -> Bot {
    try JSONDecoder().decode(Bot.self, from: Data(json.utf8))
}

@Test func theNewestTaskIsTheCurrentOne() {
    let a = entry("a", "user") { $0.text = "fix the build"; $0.task = true }
    let b = entry("b", "user") { $0.text = "and the docs"; $0.task = true }
    #expect(Tasks.current(in: [a, b, entry("n", "notice")])?.id == "b")
    #expect(Tasks.current(in: [entry("u", "user") { $0.text = "before tasks" }]) == nil)
    #expect(Tasks.current(in: [entry("r", "user", thread: "a") { $0.task = true }]) == nil)
}

@Test func aTaskIsWorkingWaitingStoppedOrDone() throws {
    let root = entry("t", "user") { $0.task = true }
    let working = try bot(#"{"id":"b","workingLanes":[{"chat":"b","thread":"t"}]}"#)
    let idle = try bot(#"{"id":"b","workingLanes":[]}"#)
    let stopped = entry("s", "notice", thread: "t") { $0.text = "Stopped." }
    #expect(Tasks.status(of: root, bot: working, replies: []) == .working)
    #expect(Tasks.status(of: root, bot: working, replies: [entry("p", "permission", thread: "t") { $0.status = "pending" }]) == .needsYou)
    #expect(Tasks.status(of: root, bot: idle, replies: [stopped]) == .stopped)
    #expect(Tasks.status(of: root, bot: idle, replies: [stopped, entry("r", "agent", thread: "t") { $0.final = true }]) == .done)
}

@Test func aTaskShowsInlineWhileBusyAndWhileTheNewestIsFresh() {
    let now: Int64 = 100 * Tasks.idleMs
    #expect(Tasks.isOpen(.done, newest: true, lastAt: now - 60_000, now: now))
    #expect(!Tasks.isOpen(.done, newest: true, lastAt: now - Tasks.idleMs, now: now))
    #expect(!Tasks.isOpen(.done, newest: false, lastAt: now - 60_000, now: now))
    #expect(Tasks.isOpen(.working, newest: false, lastAt: 0, now: now))
    #expect(!Tasks.isOpen(.working, newest: true, lastAt: now, now: now, choice: false))
    #expect(Tasks.isOpen(.done, newest: false, lastAt: 0, now: now, choice: true))
}

@Test func aVoiceCallFollowsTheChatAndItsTasksNotOtherThreads() {
    let all = [entry("p", "agent"), entry("t", "user") { $0.task = true }, entry("a", "agent", thread: "t"),
               entry("x", "agent", thread: "p")]
    #expect(Tasks.chatAndTasks(all).map(\.id) == ["p", "t", "a"])
}

@Test func aCardIsTitledByItsFirstMessage() throws {
    #expect(Tasks.title(entry("t", "user") { $0.text = "  fix\nthe   build "; $0.task = true }) == "fix the build")
    #expect(Tasks.title(entry("t", "user") { $0.task = true }) == "Task")
    #expect(try bot(#"{"id":"b"}"#).usesTasks)
    #expect(try !bot(#"{"id":"b","tasks":false}"#).usesTasks)
    #expect(try !bot(#"{"id":"g","kind":"group"}"#).usesTasks)
}
