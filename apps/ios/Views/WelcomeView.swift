import KithKit
import KithUI
import SwiftUI

/// First launch, before any setup: who the bots are, one way forward.
struct WelcomeView: View {
    let start: () -> Void
    @Environment(AccountSession.self) private var account
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 0 = nothing yet … 3 = everything shown. Each beat enters in turn.
    @State private var beat = 0

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                content
                    .frame(minHeight: geometry.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background { SkyBackground(.home) }
        .task {
            if reduceMotion { beat = 3; return }
            for next in 1...3 {
                try? await Task.sleep(for: .milliseconds(next == 1 ? 150 : 280))
                withAnimation(.spring(duration: 0.6, bounce: 0.25)) { beat = next }
            }
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 48)

            Crew(shown: beat >= 1)
                .frame(maxWidth: .infinity)

            Spacer(minLength: 32)

            VStack(spacing: 10) {
                Text("Your coding agents, as teammates.")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Palette.text)
                    .multilineTextAlignment(.center)
                Text("Give each one a name and a project. They work on your computer while you're away.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            .rise(beat >= 2)

            Spacer(minLength: 48)

            VStack(spacing: 10) {
                Button(action: start) {
                    Text("Get started").font(.headline).frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.ink)
                // Signed in, the computers on the account show up without scanning a code.
                if account.isConfigured { SignInButtons() }
                if let message = account.errorMessage {
                    Text(message).font(.footnote).foregroundStyle(Palette.danger)
                        .transition(.opacity)
                }
            }
            .rise(beat >= 3)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
    }
}

/// Five bots bobbing out of step: the "persistent, named" part of the pitch, without words.
private struct Crew: View {
    let shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let members: [(bot: String, color: String, size: CGFloat, x: CGFloat, y: CGFloat, mood: CharacterAvatar.Mood)] = [
        ("crew-builder", "", 92, 0, 0, .working),
        ("crew-designer", "kith:coral", 64, -104, -34, .idle),
        ("crew-lab", "kith:violet", 58, 100, -46, .working),
        ("spare-globe", "kith:green", 48, -76, 64, .idle),
        ("crew-house", "kith:peach", 52, 84, 58, .needsInput),
    ]

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || !shown)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                ForEach(members.indices, id: \.self) { i in
                    let m = members[i]
                    CharacterAvatar(portrait: m.bot, color: m.color, size: m.size, mood: m.mood, id: m.bot)
                        .offset(x: m.x, y: m.y + (reduceMotion ? 0 : sin(t * 1.3 + Double(i) * 1.7) * 5))
                        .scaleEffect(shown ? 1 : 0.3)
                        .opacity(shown ? 1 : 0)
                        .animation(.spring(duration: 0.7, bounce: 0.4).delay(Double(i) * 0.07), value: shown)
                }
            }
        }
        .frame(height: 170)
    }
}

private extension View {
    func bubble(_ fill: Color) -> some View {
        font(.subheadline)
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(fill, in: RoundedRectangle(cornerRadius: 18))
    }

    /// Fades up into place once `shown`.
    func rise(_ shown: Bool) -> some View {
        opacity(shown ? 1 : 0).offset(y: shown ? 0 : 14)
    }
}
