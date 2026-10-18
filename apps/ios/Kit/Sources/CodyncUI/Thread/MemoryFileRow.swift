import CodyncKit
import SwiftUI

/// A bot's change to a memory file in the chat: "Updated people.md" with the diff and an undo, a change put back
/// and why, or for a bot that asks first, the change waiting for the user.
struct MemoryFileRow: View {
    let entry: Entry
    let card: MemoryFileCard
    @Environment(BotStore.self) private var model
    @State private var expanded = false

    var body: some View {
        let answering = model.answering[entry.id] != nil
        if card.choice == .answer {
            VStack(alignment: .leading, spacing: 10) {
                line
                if let diff = card.diff, !diff.isEmpty { LineDiff(text: diff) }
                HStack(spacing: 8) {
                    if answering {
                        Spinner()
                    } else {
                        Button("Allow") { model.answerMemory(entry, .approve) }.buttonStyle(PrimaryButtonStyle())
                        Button("Don't") { model.answerMemory(entry, .decline) }.buttonStyle(SecondaryButtonStyle())
                    }
                }
            }
            .padding(12)
            .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 14))
            .padding(.trailing, 40)
        } else {
            HStack(alignment: expanded ? .top : .center, spacing: 4) {
                if let diff = card.diff, !diff.isEmpty, card.status != "restored" {
                    Disclosure(isExpanded: $expanded) { LineDiff(text: diff) } label: { line }
                } else {
                    line.frame(maxWidth: .infinity)
                }
                if card.choice == .undo {
                    if answering {
                        Spinner()
                    } else {
                        IconButton("Undo", systemImage: "arrow.uturn.backward") { model.answerMemory(entry, .undo) }
                    }
                }
            }
            .padding(.horizontal, 12)
        }
    }

    private var line: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: card.status == "restored" ? "exclamationmark.triangle" : "doc.text").font(.caption2)
            Text(entry.data.text ?? "")
            if card.big == true, card.choice == .undo {
                Text("Removes much of it").foregroundStyle(Palette.attention)
            }
        }
        .font(.footnote)
        .foregroundStyle(Palette.secondary)
    }
}

/// `- ` removed and `+ ` added lines, colored.
struct LineDiff: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : String(line))
                    .foregroundStyle(line.hasPrefix("+ ") ? Palette.added : line.hasPrefix("- ") ? Palette.removed : Palette.secondary)
            }
        }
        .font(.caption.monospaced())
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))
    }
}
