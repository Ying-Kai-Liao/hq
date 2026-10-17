import CodyncKit
import SwiftUI

/// "Earlier context was summarized to make room." The harness's summary unfolds under it when there is one.
struct CompactionRow: View {
    let entry: Entry
    let compaction: Compaction
    @State private var expanded = false

    var body: some View {
        if let summary = compaction.summary, !summary.isEmpty {
            Disclosure(isExpanded: $expanded) {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                line
            }
            .padding(.horizontal, 12)
        } else {
            line.frame(maxWidth: .infinity)
        }
    }

    private var line: some View {
        Label(entry.data.text ?? "", systemImage: "arrow.down.right.and.arrow.up.left")
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
    }
}

/// The bot's chat starts over: what the new conversation carries, which the user can edit, or turn down to carry on.
struct HandoffCardRow: View {
    let entry: Entry
    let card: HandoffCard
    @Environment(BotStore.self) private var model
    @State private var expanded = false
    @State private var editing = false

    var body: some View {
        if card.isDraft {
            VStack(alignment: .leading, spacing: 10) {
                Label(entry.data.text ?? "", systemImage: "arrow.triangle.branch")
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                Disclosure(isExpanded: $expanded) {
                    carried
                } label: {
                    Text("What it carries").font(.footnote.weight(.medium)).foregroundStyle(Palette.text)
                }
                HStack(spacing: 8) {
                    if model.answering[entry.id] != nil {
                        Spinner()
                    } else {
                        Button("Keep this conversation") { model.keepConversation(entry) }
                            .buttonStyle(SecondaryButtonStyle())
                        IconButton("Edit what it carries", systemImage: "pencil") {
                            withAnimation(Motion.layout) { editing = true }
                        }
                    }
                }
            }
            .padding(12)
            .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 14))
            .padding(.trailing, 40)
            .codyncSheet(isPresented: $editing) { HandoffEditorView(entry: entry, text: card.text ?? "") }
        } else {
            Disclosure(isExpanded: $expanded) {
                carried
            } label: {
                Label(entry.data.text ?? "", systemImage: "arrow.triangle.branch")
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
            }
            .padding(.horizontal, 12)
        }
    }

    private var carried: some View {
        Text(card.text ?? "")
            .font(.footnote.monospaced())
            .foregroundStyle(Palette.secondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Edits what the next conversation starts with.
struct HandoffEditorView: View {
    let entry: Entry
    @State private var text: String
    @State private var saving = false
    @Environment(BotStore.self) private var model
    @Environment(\.dismissModal) private var dismiss

    init(entry: Entry, text: String) {
        self.entry = entry
        _text = State(initialValue: text)
    }

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader("Edit the handoff") {
                if saving {
                    Spinner()
                } else {
                    IconButton("Save", systemImage: "checkmark") {
                        saving = true
                        Task {
                            if await model.editHandoff(entry, text: trimmed) { dismiss() }
                            saving = false
                        }
                    }
                    .disabled(trimmed.isEmpty)
                }
            }
            CardForm {
                CardSection(footer: "Your next message starts a fresh conversation that begins with this.") {
                    TextField("What the new conversation should know", text: $text, axis: .vertical)
                        .lineLimit(10...24)
                        .font(.footnote.monospaced())
                }
            }
            .textFieldStyle(.plain)
        }
        .background(Palette.background)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}
