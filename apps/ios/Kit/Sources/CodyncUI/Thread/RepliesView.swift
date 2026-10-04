import CodyncKit
import SwiftUI

/// A thread (Slack's "reply in thread"): the message it started on, its replies,
/// and a box to continue there. In a bot's own chat the thread is a separate branch
/// of the conversation (its own session, forked from the chat); in a group the room
/// answers inside the thread.
struct RepliesView: View {
    let botId: String
    let rootId: String
    let close: () -> Void
    @Environment(BotStore.self) var model
    @State var showTrace = false
        @State var following = true
        @Environment(\.accessibilityReduceMotion) var reduceMotion

    var chat: Bot? { model.bots[botId] }
    var root: Entry? { model.allEntries(botId).first { $0.id == rootId } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Thread").appFont(AppFont.compactBody.weight(.semibold)).foregroundStyle(Palette.text)
                    Text(chat?.name ?? "").appFont(.caption).foregroundStyle(Palette.tertiary).lineLimit(1)
                }
                Spacer(minLength: 8)
                IconButton("Close thread", systemImage: "xmark", action: close)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.leading, InterfaceMetrics.value(mac: 16, mobile: 20))
            .padding(.trailing, InterfaceMetrics.value(mac: 10, mobile: 12))
            .frame(height: InterfaceMetrics.value(mac: 48, mobile: 56))
            Rectangle().fill(Palette.border).frame(height: 0.5)

            // The replies: each platform's own `messages`, in its `RepliesView+` file.
            messages
                .safeAreaInset(edge: .bottom) {
                    if let mismatch = model.mismatch {
                        UpdateNeededCard(store: model, mismatch: mismatch)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                    } else {
                        Composer(botId: botId, thread: rootId)
                    }
                }
        }
        .background(Palette.background)
        .task(id: rootId) { await model.loadThread(botId, root: rootId) }
        // A thread is read on its own: having it open reads its replies.
        .readingConversation(botId, thread: rootId)
        .codyncSheet(isPresented: $showTrace) {
            TraceView(botId: botId, thread: rootId)
        }
    }
}

/// Which thread is open.
struct ThreadTarget: Identifiable, Equatable {
    let id: String
}
