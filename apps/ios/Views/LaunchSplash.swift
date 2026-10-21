import CodyncKit
import CodyncUI
import SwiftUI

/// Cold launch: the app-icon bot pops out of the system launch screen and looks around while the
/// computers connect and catch up, then zooms away onto a list that's already current.
/// Held at least `shortest` so the motion reads, never past `longest` (the cached list is behind it).
struct LaunchSplash: View {
    let stores: [BotStore]
    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var waited = false

    private static let shortest: Duration = .milliseconds(700)
    private static let longest: Duration = .milliseconds(1800)

    private var ready: Bool { waited && stores.allSatisfy(\.caughtUp) }

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            CharacterAvatar(shape: "squircle", tint: Palette.text, size: 112, mood: .working)
                .offset(y: reduceMotion ? 0 : sin(t * 2.4) * 4)
        }
        .scaleEffect(shown || reduceMotion ? 1 : 0.6)
        .opacity(shown ? 1 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
        .accessibilityLabel("Connecting")
        .task {
            withAnimation(.spring(duration: 0.5, bounce: 0.35)) { shown = true }
            try? await Task.sleep(for: Self.shortest)
            waited = true
            try? await Task.sleep(for: Self.longest - Self.shortest)
            done()
        }
        .onChange(of: ready, initial: true) { _, ready in if ready { done() } }
        // Leaving: the bot grows a little as everything fades through to the app.
        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.15)))
    }
}
