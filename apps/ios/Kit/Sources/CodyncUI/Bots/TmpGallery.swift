import SwiftUI
import CodyncKit

// TEMPORARY verification harness; not committed.
public struct AvatarGallery: View {
    @State private var draft = BotDraft(name: "Sam")
    @State private var tick = 0
    private var step: Int { Int(Date().timeIntervalSince1970 / 3.2) }
    private let moods: [CharacterAvatar.Mood] = [.idle, .working, .idle, .needsInput, .error, .idle]
    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()
    private var mood: CharacterAvatar.Mood { moods[step % moods.count] }
    private let rows = ["crew-branding", "crew-coder", "crew-designer", "crew-devops", "crew-finance", "crew-house", "crew-image", "crew-lab",
                        "crew-marketing", "crew-modeler", "crew-pemo", "crew-sound"]

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("mood: \(String(describing: mood)) \(tick)").font(.caption)
                HStack(spacing: 14) {
                    CharacterAvatar(portrait: "crew-builder", size: 110, mood: mood, id: "builder")
                    CharacterAvatar(portrait: "crew-coder", color: "kith:coral", size: 92, mood: mood, id: "coder")
                    CharacterAvatar(portrait: nil, size: 80)
                }
                HStack(spacing: 14) {
                    CharacterAvatar(portrait: "crew-lab", color: "kith:violet", size: 64, mood: mood, id: "lab")
                    CharacterAvatar(portrait: "crew-designer", color: "kith:mint", size: 64, mood: mood, id: "designer")
                    CharacterAvatar(portrait: "spare-globe", color: "kith:sun", size: 64, mood: .idle, id: "globe")
                }
                ForEach(rows, id: \.self) { r in
                    HStack {
                        CharacterAvatar(portrait: r, size: 28, id: r)
                        CharacterAvatar(portrait: r, size: 18, id: r)
                        Text(r).font(.subheadline)
                    }
                }
                AvatarPicker(draft: $draft, automatic: "crew-builder")
            }
            .padding()
        }
        .onReceive(timer) { _ in tick += 1 }
    }
}
