import CodyncKit
import SwiftUI

extension RepliesView {
    /// iPhone: the replies follow the newest one until the reader scrolls away.
    @ViewBuilder var messages: some View {
        let replies = model.replies(botId, root: rootId)
        let working = chat?.isWorking(in: botId, thread: rootId) == true && !model.isOffline
        let items = ChatItem.build(replies, streaming: working, steady: true)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let root {
                    ChatRow(entry: root, groupStart: true, chat: chat) { showTrace = true }
                        .equatable()
                    HStack(spacing: 10) {
                        Text(replies.isEmpty ? "No replies yet" : replies.count == 1 ? "1 reply" : "\(replies.count) replies")
                            .appFont(.caption)
                            .foregroundStyle(Palette.tertiary)
                            .fixedSize()
                        Rectangle().fill(Palette.border).frame(height: 1)
                    }
                    .padding(.vertical, 12)
                }
                ForEach(items) { item in
                    if case let .entry(e, groupStart) = item.kind {
                        ChatRow(entry: e, groupStart: groupStart, chat: chat) { showTrace = true }
                            .equatable()
                            .id(item.id)
                            .transition(item.id == items.last?.id
                                ? .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)
                                : .identity)
                    }
                }
                if let chat, working {
                    WorkingIndicator(bot: chat, thinking: model.currentThinking(botId, thread: rootId))
                        .padding(.top, 6)
                        .transition(.opacity)
                }
                Color.clear.frame(height: 8).id("bottom")
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .animation(Motion.reduced(Motion.conversation, reduceMotion), value: items.last?.id)
            .animation(Motion.reduced(Motion.layout, reduceMotion), value: working)
        }
        .scrollIndicators(.never)
        .followsConversation($following)
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: items.last?.id) { _, _ in
            if items.last?.isUserMessage == true { following = true }
        }
        .overlay(alignment: .bottom) {
            JumpToLatest(visible: !following && !items.isEmpty) { following = true }
        }
    }
}
