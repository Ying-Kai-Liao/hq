import CodyncKit
import SwiftUI

/// iPhone: a row renders again only when what it shows changed, so a reply being written
/// elsewhere in the chat skips it.
extension ChatRow: @MainActor Equatable {
    static func == (a: Self, b: Self) -> Bool {
        a.entry == b.entry && a.groupStart == b.groupStart && a.chat?.isGroup == b.chat?.isGroup
            && a.chat?.isWorking == b.chat?.isWorking && (a.openThread == nil) == (b.openThread == nil)
    }
}

/// A reply as it's written. The host sends text in bursts; in between, what arrived is
/// revealed at a steady pace, so the reply flows instead of jumping a line at a time.
struct StreamingMarkdown: View {
    let text: String
    /// Still being written (`final == false`).
    let live: Bool
    /// Characters shown while revealing; nil shows all of it.
    @State private var shown: Int?
    /// Text is surfacing right now (caught up, the fade settles).
    @State private var revealing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conversationScrolling) private var scrolling

    /// How long a burst takes to reveal: a bit over the host's flush interval, so bursts join up.
    private static let window = 0.32
    private static let frame = 1.0 / 60

    var body: some View {
        MarkdownText(shown.map { String(text.prefix($0)) } ?? text, streaming: live, revealing: revealing)
            .equatable()
            .onAppear {
                // A reply already well under way when it scrolls in shows as it is.
                if live, !reduceMotion, shown == nil { shown = text.count > 280 ? text.count : 0 }
            }
            .task(id: RevealTarget(text: text, live: live, paused: scrolling)) { await reveal() }
    }

    private func reveal() async {
        // While the reader scrolls, the text holds still: scrolling never competes with layout.
        guard let start = shown, !scrolling else { return }
        let total = text.count
        var position = Double(min(start, total))
        let step = max((Double(total) - position) / (Self.window / Self.frame), 0.5)
        revealing = position < Double(total)
        defer { if !Task.isCancelled { revealing = false } }
        while position < Double(total) {
            try? await Task.sleep(for: .seconds(Self.frame))
            if Task.isCancelled { return }
            position = min(Double(total), position + step)
            shown = Int(position)
        }
        // Between bursts the open end keeps its fade a moment, so it doesn't flicker.
        if live { try? await Task.sleep(for: .seconds(0.6)) }
        if Task.isCancelled { return }
        if !live { shown = nil }
    }

    private struct RevealTarget: Equatable {
        let text: String
        let live: Bool
        let paused: Bool
    }
}

extension EnvironmentValues {
    /// The reader is scrolling the conversation: streamed text holds still until they stop.
    @Entry var conversationScrolling = false
}
