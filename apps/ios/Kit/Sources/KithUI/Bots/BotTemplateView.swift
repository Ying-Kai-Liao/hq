import KithKit
import SwiftUI

/// A portable settings snapshot, with no conversation identity or runtime state.
struct BotTemplateView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copied = false
    private let template: BotDraft
    private let encoded: String?

    init(draft: BotDraft) {
        var template = draft
        template.id = nil
        template.pinned = nil
        template.hidden = nil
        self.template = template
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoded = (try? encoder.encode(template)).flatMap { String(data: $0, encoding: .utf8) }
    }

    var body: some View {
        VStack(spacing: 0) {
        ModalHeader("Create template")
        VStack(alignment: .leading, spacing: 20) {
            Text(template.name).font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.muted)
            Text("Copy this bot’s settings to reuse as a template. Conversation history and conversation ID are excluded.")
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
            ScrollView {
                Text(encoded ?? "Unable to create this template.")
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            HStack {
                Text("Includes workspace preferences and agent configuration.")
                    .font(.system(size: 11.5)).foregroundStyle(Palette.muted)
                Spacer()
                Button {
                    Pasteboard.copy(encoded)
                    withAnimation(Motion.reduced(Motion.morph, reduceMotion)) { copied = true }
                } label: {
                    Label(copied ? "Copied" : "Copy template", systemImage: copied ? "checkmark" : "square.on.square")
                        .font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 18).padding(.vertical, 9)
                        .foregroundStyle(Palette.onAccent)
                        .background(Palette.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(encoded == nil)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding([.horizontal, .bottom], 24)
        }
        .background(Palette.background)
    }
}
