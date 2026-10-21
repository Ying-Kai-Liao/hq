import CodyncKit
import SwiftUI

/// The `/` list above the box: each command's icon, name and what it does; tapping one runs it.
struct CommandList: View {
    let commands: [SlashCommand]
    let pick: (SlashCommand) -> Void

    var body: some View {
        // Scrolls only once it's taller than the room it gets.
        ViewThatFits(in: .vertical) {
            rows
            ScrollView { rows }.scrollIndicators(.hidden)
        }
        .frame(maxHeight: 280, alignment: .bottom)
        .glass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(commands) { command in
                Button { pick(command) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: command.icon)
                            .font(.subheadline)
                            .foregroundStyle(Palette.secondary)
                            .frame(width: 20)
                        Text(command.title).font(.subheadline).foregroundStyle(Palette.text)
                        Text(command.detail)
                            .font(.subheadline)
                            .foregroundStyle(command.warning ? Palette.warning : Palette.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressScale())
                .accessibilityLabel(command.title)
                .accessibilityHint(command.detail)
            }
        }
        .padding(.vertical, 6)
    }
}
