import Foundation
import Testing
@testable import CodyncKit
@testable import CodyncUI

/// The chat shows user messages and final replies; while a turn runs, only the text being
/// generated right now joins them. Earlier narration and room passes never do.
@Test func chatShowsOnlyFinalRepliesAndTheTextBeingGenerated() {
    func entry(_ seq: Int64, _ kind: String, _ text: String? = nil, final: Bool? = nil) -> Entry {
        var data = EntryData(text: text)
        data.final = final
        return Entry(id: "e\(seq)", seq: seq, botId: "b", rev: seq, kind: kind, turn: 1, data: data, createdAt: 0, updatedAt: 0)
    }
    let ids = { (items: [ChatItem]) in items.compactMap { if case let .entry(e, _) = $0.kind { e.id } else { nil } } }

    // Mid-turn: narration closed by a tool call, then the answer streaming.
    let running = [entry(1, "user", "Fix it"), entry(2, "agent", "I'll read it first.", final: false),
                   entry(3, "tool_call", "Read"), entry(4, "agent", "Done. It raced", final: false)]
    #expect(ids(ChatItem.build(running, streaming: true)) == ["e1", "e4"])
    #expect(ids(ChatItem.build(running)) == ["e1"])
    // Idle: the last text has been marked final; narration stays trace-only.
    let done = [running[0], running[1], running[2], entry(4, "agent", "Done. It raced the refresh.", final: true)]
    #expect(ids(ChatItem.build(done)) == ["e1", "e4"])
    // A room pass is being generated: still not chat.
    #expect(ids(ChatItem.build([running[0], entry(2, "agent", "(pass)", final: false)], streaming: true)) == ["e1"])
}

/// iPhone (`steady`): the turn's newest text stays while tools run, and a reply is one item
/// from its first words to the final message.
@Test func steadyChatKeepsTheTurnsNewestTextInOneBubble() {
    func entry(_ seq: Int64, _ kind: String, _ text: String? = nil, final: Bool? = nil) -> Entry {
        var data = EntryData(text: text)
        data.final = final
        return Entry(id: "e\(seq)", seq: seq, botId: "b", rev: seq, kind: kind, turn: 1, data: data, createdAt: 0, updatedAt: 0)
    }
    let ids = { (items: [ChatItem]) in items.compactMap { if case let .entry(e, _) = $0.kind { e.id } else { nil } } }
    let build = { (entries: [Entry], streaming: Bool) in ChatItem.build(entries, streaming: streaming, steady: true) }

    let running = [entry(1, "user", "Fix it"), entry(2, "agent", "I'll read it first.", final: false),
                   entry(3, "tool_call", "Read"), entry(4, "agent", "Done. It raced", final: false)]
    let done = [running[0], running[1], running[2], entry(4, "agent", "Done. It raced the refresh.", final: true)]
    #expect(ids(build(running, true)) == ["e1", "e4"])
    #expect(ids(build(running, false)) == ["e1"])
    #expect(ids(build(done, false)) == ["e1", "e4"])
    // A tool runs after the narration: the narration stays until newer text comes.
    #expect(ids(build(Array(running.prefix(3)), true)) == ["e1", "e2"])
    // Narration, the answer being written and the final reply are the same bubble.
    let live = build(running, true).last?.id
    #expect(live == build(done, false).last?.id)
    #expect(build(Array(running.prefix(3)), true).last?.id == live)
    // A room pass is being generated: still not chat.
    #expect(ids(build([running[0], entry(2, "agent", "(pass)", final: false)], true)) == ["e1"])
}

/// Text being written hides half-typed markers instead of flashing them raw.
@Test func markdownBlocksHealTheOpenEnd() {
    #expect(MarkdownBlocks.heal("so **bo") == "so **bo**")
    #expect(MarkdownBlocks.heal("run `ls") == "run `ls`")
    #expect(MarkdownBlocks.heal("`a**b` and **c") == "`a**b` and **c**")
    #expect(MarkdownBlocks.heal("see [the docs](https://exa") == "see the docs")
    #expect(MarkdownBlocks.heal("see [the do") == "see the do")
    #expect(MarkdownBlocks.heal("- [ ] task") == "- [ ] task")
    #expect(MarkdownBlocks.heal("done [x](y) **ok**") == "done [x](y) **ok**")
    // Only the block being written is healed.
    #expect(MarkdownBlocks.parse("**a\n\nb **c", streaming: true) == [.paragraph("**a"), .paragraph("b **c**")])
}

/// Tables, rules and nested lists, as agents write them.
@Test func markdownBlocksParseTablesRulesAndNesting() {
    let blocks = MarkdownBlocks.parse("""
    | Name | Size |
    |---|:-:|
    | a | 1 |
    ---
    - top
      - inner
    | not a table
    """)
    #expect(blocks == [
        .table(header: ["Name", "Size"], rows: [["a", "1"]]),
        .rule,
        .bullet("top", marker: "•", depth: 0),
        .bullet("inner", marker: "◦", depth: 1),
        .paragraph("| not a table"),
    ])
}

@Test func messagesWithoutClientNoncesHaveDistinctRowAndSeparatorIdentities() {
    let entries = ["", "", nil].enumerated().map { index, nonce in
        Entry(id: "incoming-\(index)", seq: Int64(index), botId: "b", rev: Int64(index), kind: "user", turn: 1,
              data: EntryData(text: "Incoming message \(index)", clientNonce: nonce),
              createdAt: Int64(index) * 7_200_000, updatedAt: 0)
    }
    let items = ChatItem.build(entries)
    let messageIDs = items.compactMap { item -> String? in
        if case .entry = item.kind { item.id } else { nil }
    }
    #expect(messageIDs == entries.map(\.id))
    #expect(Set(items.map(\.id)).count == items.count)
}

@Test func optimisticMessageKeepsItsRowIdentityAfterAcknowledgement() {
    let data = EntryData(text: "Sent message", clientNonce: "client-nonce")
    let optimistic = Entry(id: "local-client-nonce", seq: 0, botId: "b", rev: 0, kind: "user", turn: 1,
                           data: data, createdAt: 0, updatedAt: 0)
    var delivered = optimistic
    delivered.id = "server-entry"
    delivered.seq = 10
    delivered.rev = 11
    let pendingItems = ChatItem.build([optimistic])
    let deliveredItems = ChatItem.build([delivered])
    #expect(pendingItems.map(\.id) == deliveredItems.map(\.id))
}
