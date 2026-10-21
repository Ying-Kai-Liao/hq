import SwiftUI

extension View {
    func readingConversation(_ botId: String, thread: String? = nil) -> some View {
        modifier(ReadingConversation(botId: botId, thread: thread))
    }
}

/// A scoped read receipt follows view visibility, rather than roster selection.
private struct ReadingConversation: ViewModifier {
    let botId: String
    let thread: String?
    @Environment(BotStore.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var token = UUID()
    @State private var visible = false

    func body(content: Content) -> some View {
        content
            .onAppear { visible = true; update() }
            .onDisappear { visible = false; update() }
            .onChange(of: scenePhase) { _, _ in update() }
            .onChange(of: botId) { _, _ in update() }
            .onChange(of: thread) { _, _ in update() }
            .onChange(of: model.connection) { _, _ in update() }
    }

    private func update() {
        model.setReading(token, botId: botId, thread: thread,
                         active: visible && scenePhase == .active)
    }
}
