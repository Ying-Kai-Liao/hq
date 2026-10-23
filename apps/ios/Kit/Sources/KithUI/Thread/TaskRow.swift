import KithKit
import SwiftUI

/// A task in the chat: inline (its first message, the thread under it, the bot at work) while it's going, a card once
/// it's idle. The card opens it; the open task folds back. An older task goes on in its thread (`openThread`).
struct TaskRow: View {
    let root: Entry
    let bot: Bot
    let newest: Bool
    /// What the user picked on this device: open or folded; nil follows the task.
    @Binding var choice: Bool?
    let openTrace: () -> Void
    let openThread: () -> Void
    @Environment(BotStore.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Ticks so an idle task folds on its own.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let replies = model.replies(bot.id, root: root.id)
            let status = Tasks.status(of: root, bot: bot, replies: replies)
            let now = Int64(context.date.timeIntervalSince1970 * 1000)
            let open = Tasks.isOpen(status, newest: newest, lastAt: Tasks.lastAt(root), now: now, choice: choice)
            // An older reply can be missing when only live ones arrived: load the whole thread.
            let missing = open && replies.count < (root.data.thread?.count ?? 0)
            // The composer goes on with this task; any other one goes on in its thread.
            let goesOn = newest && Tasks.isOpen(status, newest: newest, lastAt: Tasks.lastAt(root), now: now)
            Group {
                if open { expanded(replies, status, goesOn: goesOn) } else { card(status) }
            }
            .task(id: missing) {
                if missing { await model.loadThread(bot.id, root: root.id) }
            }
        }
    }

    private func card(_ status: TaskStatus) -> some View {
        let count = root.data.thread?.count ?? 0
        return Button {
            withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { choice = true }
        } label: {
            HStack(spacing: 8) {
                StatusIcon(status: status)
                Text(Tasks.title(root))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(count == 1 ? "1 reply" : "\(count) replies") · \(RelativeTime.day(Date(milliseconds: Tasks.lastAt(root))))")
                    .font(.footnote)
                    .foregroundStyle(Palette.tertiary)
                    .lineLimit(1)
                    .fixedSize()
                Image(systemName: "chevron.down").font(.caption2).foregroundStyle(Palette.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .padding(.vertical, 4)
        .accessibilityLabel("Open task: \(Tasks.title(root)), \(status.label)")
    }

    private func expanded(_ replies: [Entry], _ status: TaskStatus, goesOn: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                StatusIcon(status: status)
                Text(status.label).font(.caption).foregroundStyle(Palette.secondary)
                Spacer(minLength: 8)
                if status.isBusy {
                    IconButton("Stop this task", systemImage: "stop.fill") { model.stop(bot.id, thread: root.id) }
                }
                if !goesOn {
                    IconButton("Continue this task", systemImage: "arrowshape.turn.up.left", action: openThread)
                }
                IconButton("Fold this task", systemImage: "chevron.up") {
                    withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { choice = false }
                }
            }
            ChatRow(entry: root, groupStart: true, chat: bot, openTrace: openTrace)
            ForEach(ChatItem.build(replies)) { item in
                if case let .entry(e, groupStart) = item.kind {
                    ChatRow(entry: e, groupStart: groupStart, chat: bot, openTrace: openTrace)
                }
            }
            if status.isBusy && !model.isOffline {
                WorkingIndicator(bot: bot, thinking: model.currentThinking(bot.id, thread: root.id))
                    .padding(.top, 6)
            }
        }
        .padding(.vertical, 4)
        // Its thread is on screen: the bot's answers here are read.
        .readingConversation(bot.id, thread: root.id)
    }
}

private struct StatusIcon: View {
    let status: TaskStatus

    var body: some View {
        switch status {
        case .working: Spinner(size: 9)
        case .needsYou: Image(systemName: "exclamationmark.circle").font(.caption).foregroundStyle(Palette.attention)
        case .stopped: Image(systemName: "stop.circle").font(.caption).foregroundStyle(Palette.tertiary)
        case .done: Image(systemName: "checkmark.circle").font(.caption).foregroundStyle(Palette.tertiary)
        }
    }
}
