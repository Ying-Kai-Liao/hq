#if os(macOS)
import AppKit
import SwiftUI
import Testing
import Vision
@testable import CodyncKit
@testable import CodyncUI

@MainActor @Test func incomingBotMessagesWithEmptyNoncesRemainVisible() async throws {
    _ = NSApplication.shared
    let suite = "IncomingBotMessageTests.\(UUID())"
    let storage = SharedStore.Context(accountID: suite, suite: suite)
    defer { storage.erase(); UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
    let fake = FakeRemote(.ready(.direct))
    let store = BotStore(computer: Computer(id: "incoming-fixture", name: "Fixture", signKey: ""),
                         route: .channel, clientKind: "macos", storage: storage) { fake }
    defer { store.retire() }
    store.setActive(true)
    try await waitFor { await fake.subscribed }
    await fake.emit(botEvent(status: "idle", rev: 1))
    let oldMarker = "Old incoming message remains visible."
    await fake.emit(try entryEvent(id: "old-incoming", seq: 1, rev: 2, text: oldMarker + "\n\n" + String(repeating: "An earlier bot submitted this request. ", count: 5), final: false, kind: "user", nonce: ""))
    await fake.emit(try entryEvent(id: "old-reply", seq: 2, rev: 3, text: "Earlier response before the next incoming alert.", final: true))
    try await waitFor { store.allEntries("b").count == 2 }
    let hosting = NSHostingView(rootView: ThreadView(botId: "b")
        .environment(store))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 1080), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: .aqua)
    window.contentView = hosting
    defer { window.close() }
    hosting.layoutSubtreeIfNeeded()
    hosting.displayIfNeeded()
    try await Task.sleep(for: .milliseconds(600))
    let newMarker = "New incoming message fills this space."
    await fake.emit(botEvent(status: "working", rev: 4))
    await fake.emit(try entryEvent(id: "new-incoming", seq: 3, rev: 5,
                                 text: newMarker + "\n\n" + String(repeating: "The latest incoming alert must render between the preceding response and its final reply. ", count: 15),
                                 final: false, kind: "user", nonce: ""))
    try await waitFor { store.allEntries("b").count == 3 }
    try await Task.sleep(for: .milliseconds(600))
    await fake.emit(try entryEvent(id: "new-reply", seq: 4, rev: 6, text: "Final response after the incoming alert.", final: true))
    await fake.emit(botEvent(status: "idle", rev: 7))
    try await waitFor { store.allEntries("b").count == 4 }
    try await Task.sleep(for: .seconds(1))
    hosting.layoutSubtreeIfNeeded()
    hosting.displayIfNeeded()
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    let png = try #require(bitmap.representation(using: .png, properties: [:]))
    let rendered = try await recognizeText(png)
    #expect(rendered.contains(oldMarker), "Earlier incoming message disappeared: \(rendered)")
    #expect(rendered.contains(newMarker), "Latest incoming message left a blank space: \(rendered)")
}

private func botEvent(status: String, rev: Int64) -> String {
    #"{"type":"bot","bot":{"id":"b","name":"Fixture","status":"\#(status)","rev":\#(rev),"lastAt":1}}"#
}

private func entryEvent(id: String, seq: Int64, rev: Int64, text: String, final: Bool, kind: String = "agent", nonce: String? = nil) throws -> String {
    var data = EntryData(text: text, clientNonce: nonce)
    data.final = final
    let entry = Entry(id: id, seq: seq, botId: "b", rev: rev, kind: kind, turn: seq,
                      data: data, createdAt: seq, updatedAt: rev)
    let encoded = try JSONEncoder().encode(entry)
    return "{\"type\":\"entry\",\"entry\":\(String(decoding: encoded, as: UTF8.self))}"
}

@MainActor private func waitFor(_ condition: @MainActor () async -> Bool) async throws {
    for _ in 0..<200 {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Timed out waiting for the scripted event")
}

private func recognizeText(_ png: Data) async throws -> String {
    let task = Task.detached {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let handler = VNImageRequestHandler(data: png)
        try handler.perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }
    return try await task.value
}
#endif
