import CodyncKit
import SwiftUI

/// Writes one memory: a new one, or a change to an entry.
struct MemoryEditorView: View {
    let memory: MemoryStore
    let target: MemoryEditTarget
    @State private var text: String
    @Environment(\.dismissModal) private var dismiss

    init(memory: MemoryStore, target: MemoryEditTarget) {
        self.memory = memory
        self.target = target
        _text = State(initialValue: target.text)
    }

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader(target.entry != nil ? "Edit memory" : target.shared ? "Add to what your bots share" : "Add memory") { EmptyView() }
            VStack(alignment: .leading, spacing: 16) {
                TextField("One short fact", text: $text, axis: .vertical)
                    .lineLimit(2...6)
                    .textFieldStyle(.plain)
                    .padding(12)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12))
                if let error = memory.error { Text(error).foregroundStyle(Palette.danger) }
                Button(memory.busy ? "Saving…" : "Save") {
                    Task {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if await memory.mutate("saveMemory", id: target.entry, shared: target.shared, text: trimmed) { dismiss() }
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(memory.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(20)
        }
    }
}

/// What the editor opens on: an entry (`entry`), or a new one in a layer.
struct MemoryEditTarget: Identifiable {
    let id = UUID()
    let entry: Int64?
    let shared: Bool
    let text: String
}
