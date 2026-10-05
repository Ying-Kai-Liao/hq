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
                    Text("Thread").font(.body.weight(.semibold)).foregroundStyle(Palette.text)
                    Text(chat?.name ?? "").font(.caption).foregroundStyle(Palette.tertiary).lineLimit(1)
                }
                Spacer(minLength: 8)
                IconButton("Close thread", systemImage: "xmark", action: close)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 56)
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
                            .font(.caption)
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
