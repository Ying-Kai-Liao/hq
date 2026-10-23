import Foundation
import Testing
@testable import KithKit
@testable import KithUI

private func entry(_ seq: Int64, _ kind: String, configure: (inout EntryData) -> Void = { _ in }) -> Entry {
    var data = EntryData()
    configure(&data)
    return Entry(id: "e\(seq)", seq: seq, botId: "b", threadId: "r", rev: seq, kind: kind, turn: 1, data: data, createdAt: 0, updatedAt: 0)
}

private func tool(_ seq: Int64) -> Entry {
    entry(seq, "tool") { $0.toolKind = "execute"; $0.title = "swift test"; $0.status = "completed" }
}

@Test func openThreadShowsRepliesAndToolRowsInOrderAndHidesThinking() {
    let replies = [entry(1, "thought") { $0.text = "hm" }, tool(2), entry(3, "agent") { $0.text = "Done."; $0.final = true },
                   entry(4, "plan")]
    let out = ThreadFeed.replies(replies)
    #expect(out.map(\.id) == ["e2", "e3"])
}

@Test func aLongRunOfToolCallsFoldsIntoOneEarlierLine() {
    let replies = (1...7).map(tool)
    let out = ThreadFeed.replies(replies)
    #expect(out.count == 1 + ThreadFeed.visibleSteps)
    #expect(out.first == .earlier(count: 3, id: "earlier-e1"))
    #expect(out.last?.id == "e7")
}

@Test func toolRowReadsVerbObjectAndResult() {
    let edit = entry(1, "tool") {
        $0.toolKind = "edit"; $0.status = "completed"
        $0.diffs = [FileDiff(path: "/a/kith-sessions.py", added: 6, removed: 2, isNew: false, startLine: 1, patch: "+x")]
    }
    let row = ThreadFeed.toolRow(edit)
    #expect(row.verb == "Edited" && row.object == "kith-sessions.py" && row.result == .text("+6 -2"))
    #expect(row.output == "+x")

    let failed = ThreadFeed.toolRow(entry(2, "tool") { $0.toolKind = "execute"; $0.title = "cargo build"; $0.status = "failed" })
    #expect(failed.result == .error("failed") && failed.command == "cargo build")

    // Still running: no result, so the row shows its spinner; unknown kinds read "Used".
    let running = ThreadFeed.toolRow(entry(3, "tool") { $0.title = "mcp thing"; $0.status = "in_progress" })
    #expect(running.verb == "Used" && running.result == nil)
}

@Test func aPendingPermissionIsYourTurn() {
    let pending = entry(1, "permission") { $0.status = "pending" }
    let answered = entry(2, "permission") { $0.status = "answered" }
    #expect(ThreadFeed.hasQuestion([pending]))
    #expect(!ThreadFeed.hasQuestion([answered, entry(3, "agent")]))
}

@Test func placeMapsProjectsAndFoldersAndToleratesNone() {
    #expect(ThreadFeed.place(nil) == nil)
    #expect(ThreadFeed.place(PlaceFolder(kind: "project", project: "kith", name: "kith")) == .project("kith"))
    #expect(ThreadFeed.place(PlaceFolder(kind: "folder", path: "/x", name: "x")) == .folder("x"))
}

@Test func ownMessageKeepsItsNonceIdAndGapsGetSeparators() {
    let mine = entry(1, "user") { $0.clientNonce = "n1"; $0.text = "hi" }
    var later = entry(2, "agent") { $0.text = "ok"; $0.final = true }
    later.createdAt = 2 * 3_600_000
    let out = ThreadFeed.replies([mine, later], separators: true)
    #expect(out.map(\.id) == ["sep-user-n1", "user-n1", "sep-e2", "e2"])
}

private func summary(origin: String? = nil, writer: String? = nil, busy: Bool? = nil) -> ThreadSummary {
    ThreadSummary(count: 2, lastAt: 0, authors: ["b"], unread: nil, origin: origin, liveWriter: writer, liveBusy: busy)
}

@Test func heldThreadsMapToBannerPhases() {
    #expect(ThreadFeed.writerPhase(nil, taking: false, failed: false, unreachable: false) == nil)
    #expect(ThreadFeed.writerPhase(summary(), taking: false, failed: false, unreachable: false) == nil)
    #expect(ThreadFeed.writerPhase(summary(writer: "app"), taking: false, failed: false, unreachable: false) == nil)
    let held = summary(origin: "terminal", writer: "terminal", busy: false)
    #expect(ThreadFeed.writerPhase(held, taking: false, failed: false, unreachable: false) == .idle)
    #expect(ThreadFeed.writerPhase(summary(writer: "terminal", busy: true), taking: false, failed: false, unreachable: false) == .working)
    #expect(ThreadFeed.writerPhase(held, taking: true, failed: false, unreachable: false) == .taking)
    #expect(ThreadFeed.writerPhase(held, taking: false, failed: true, unreachable: false) == .failed)
    #expect(ThreadFeed.writerPhase(held, taking: false, failed: false, unreachable: true) == .unreachable)
}

@Test func originAndWriterChipFollowTheSummary() {
    #expect(ThreadFeed.origin(summary(origin: "terminal")) == .terminal)
    #expect(ThreadFeed.origin(summary(origin: "slack")) == .slack)
    #expect(ThreadFeed.origin(summary(origin: "carrier-pigeon")) == nil)
    #expect(ThreadFeed.origin(summary()) == nil)
    #expect(ThreadFeed.writerChip(summary(writer: "terminal", busy: true), mac: "Mac mini") == .writer(working: true, mac: "Mac mini"))
    #expect(ThreadFeed.writerChip(summary(), mac: "Mac mini") == nil)
}

@Test func writerChangeNoticesBecomeDividers() {
    let notice = entry(1, "notice") { $0.writerChange = "tookOver" }
    #expect(ThreadFeed.writerDivider(notice, mac: "Mac mini") == .tookOver)
    #expect(ThreadFeed.writerDivider(entry(2, "notice") { $0.writerChange = "startedInTerminal" }, mac: "Mac mini") == .startedInTerminal(mac: "Mac mini"))
    #expect(ThreadFeed.writerDivider(entry(3, "notice") { $0.writerChange = "somethingNew" }, mac: "m") == nil)
    #expect(ThreadFeed.writerDivider(entry(4, "notice"), mac: "m") == nil)
}

@Test func aQuestionInAHeldThreadIsNotYoursToAnswer() {
    let pending = entry(1, "permission") { $0.status = "pending" }
    #expect(ThreadFeed.hasQuestion([pending]))
    #expect(!ThreadFeed.hasQuestion([pending], held: true))
}
