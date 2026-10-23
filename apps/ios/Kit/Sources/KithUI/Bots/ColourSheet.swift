import KithKit
import SwiftUI

/// The bot's look: a second sheet over the agent sheet (app-style/agent-sheet.png, 8). A live preview, the 15 brand
/// pairs as swatches, Reset, and the body to wear. Nothing is saved until Done; Cancel leaves the bot as it was.
struct ColourSheet: View {
    /// What the bot has; Done writes the look back, and the sheet above autosaves it.
    @Binding var draft: BotDraft
    var isGroup = false
    @State private var work: BotDraft
    @Environment(\.dismissModal) private var dismiss

    init(draft: Binding<BotDraft>, isGroup: Bool = false) {
        _draft = draft
        self.isGroup = isGroup
        _work = State(initialValue: draft.wrappedValue)
    }

    private var portrait: String? { CrewAvatar.asset(for: work, isGroup: isGroup) }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 14), count: 5)

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 22) {
                    CharacterAvatar(portrait: portrait, color: work.avatarColor, size: KithSize.botAvatarColourSheet, id: work.id ?? "")
                        .padding(.top, 14)
                    if !isGroup {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(AvatarPalette.colors) { swatch in self.swatch(swatch) }
                        }
                        Button {
                            withAnimation(Motion.hover) { work.avatarColor = "" }
                        } label: {
                            Label("Reset to default", systemImage: "arrow.counterclockwise")
                                .font(.system(size: 13))
                                .foregroundStyle(Palette.ink)
                        }
                        .buttonStyle(.plain)
                        .disabled(AvatarPalette.pick(work.avatarColor) == nil)
                        Text("The eyes never change.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Palette.muted)
                    }
                    AvatarPicker(draft: $work, automatic: CrewAvatar.asset(source: "auto", id: work.id ?? "", name: work.name, isGroup: isGroup),
                                 isGroup: isGroup, showsColour: false)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
        }
        .background(Palette.background)
    }

    private var header: some View {
        HStack {
            Button("Cancel") { dismiss() }
                .foregroundStyle(Palette.muted)
            Spacer()
            Text("Colour").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ink)
            Spacer()
            Button("Done") {
                draft.avatarColor = work.avatarColor
                draft.avatarSource = work.avatarSource
                dismiss()
            }
            .fontWeight(.semibold)
            .foregroundStyle(Palette.ink)
        }
        .buttonStyle(.plain)
        .font(.system(size: 15))
        .padding(.horizontal, 20)
        .frame(height: 56)
    }

    private func swatch(_ swatch: AvatarPalette.Swatch) -> some View {
        let on = work.avatarColor == swatch.stored
        return Circle()
            .fill(LinearGradient(colors: [Color(hex: swatch.a), Color(hex: swatch.b)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 40, height: 40)
            .padding(3)
            .overlay(Circle().strokeBorder(on ? Palette.ink : .clear, lineWidth: 2))
            .contentShape(Circle())
            .onTapGesture { withAnimation(Motion.hover) { work.avatarColor = swatch.stored } }
            .accessibilityLabel(swatch.label)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}
