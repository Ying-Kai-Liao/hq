import CodyncKit
import SwiftUI

/// The memory screen's info button beside the harness's own memory switch: what turning it on means. The same
/// text as the desktop app's; the terminal UI says it short in a confirmation before turning it on.
struct HarnessMemorySheet: View {
    /// The harness's name ("Claude Code").
    let harness: String
    /// Whether Codync can show the harness's notes (Claude Code's are a file on the computer).
    let readable: Bool

    private var details: [(icon: String, title: String, detail: String)] {
        [("brain", "A memory of its own", "\(harness) keeps notes apart from Codync's memory. It's off by default, so this bot has one memory and you see and change all of it here."),
         ("square.on.square", "Remembered twice", "With both on, the bot may save the same thing twice, and the two can disagree after something changes."),
         ("trash", "Forgetting", "Forgetting something here doesn't remove it from \(harness)'s notes. Codync can't change them."),
         ("eye", "Where to see it", readable ? "Its notes show read-only under the \(harness) tab." : "Codync can't show it; look in \(harness) itself.")]
    }

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader("\(harness)'s own memory")
            CardForm {
                CardSection {
                    ForEach(details, id: \.title) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Image(systemName: item.icon)
                                .foregroundStyle(Palette.secondary)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                Text(item.detail)
                                    .font(.footnote)
                                    .foregroundStyle(Palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        }
        .background(Palette.background)
    }
}
