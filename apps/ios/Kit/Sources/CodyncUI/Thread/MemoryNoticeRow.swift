import CodyncKit
import SwiftUI

/// A bot's memory write in the chat: "Remembered: …" with an undo, or a card waiting for the user's approval.
struct MemoryNoticeRow: View {
    let entry: Entry
    let card: MemoryWrite
    @Environment(BotStore.self) private var model

    var body: some View {
        let answering = model.answering[entry.id] != nil
        switch card.choice {
        case .answer:
            VStack(alignment: .leading, spacing: 10) {
                line
                HStack(spacing: 8) {
                    if answering {
                        Spinner()
                    } else {
                        Button("Remember") { model.answerMemory(entry, .approve) }.buttonStyle(PrimaryButtonStyle())
                        Button("Don't") { model.answerMemory(entry, .decline) }.buttonStyle(SecondaryButtonStyle())
                    }
                }
            }
            .padding(12)
            .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 14))
            .padding(.trailing, 40)
        case .undo:
            HStack(spacing: 4) {
                line
                if answering {
                    Spinner()
                } else {
                    IconButton("Undo", systemImage: "arrow.uturn.backward") { model.answerMemory(entry, .undo) }
                }
            }
            .frame(maxWidth: .infinity)
        case nil:
            line.frame(maxWidth: .infinity)
        }
    }

    private var line: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "brain").font(.caption2)
            Text(entry.data.text ?? "")
            if let error = card.error { Text(error).foregroundStyle(Palette.danger) }
        }
        .font(.footnote)
        .foregroundStyle(Palette.secondary)
    }
}
