import CodyncKit
import SwiftUI
import UIKit

extension ThreadView {
    var platformBody: some View {
        conversation
            .codyncSheet(item: $openThread) { target in
                RepliesView(botId: botId, rootId: target.id) { closeThread() }
            }
    }

    /// Messages rendered per page, newest first.
    static let page = 40
    /// Paging needs to know when the reader nears the top (scroll geometry); before that, all render.
    static var paged: Bool {
        if #available(iOS 18, *) { true } else { false }
    }

    private var streaming: Bool { bot?.isWorking(in: botId, thread: nil) == true && !model.isOffline }

    /// iPhone's messages: the newest page first, earlier ones as the reader scrolls up (from
    /// this device, then from the computer); the chat follows the newest message until they
    /// scroll away, and a reply is revealed steadily as it's written.
    @ViewBuilder var transcript: some View {
        let thread = model.chat(botId)
        let all = ChatItem.build(thread, streaming: streaming, steady: true)
        let start = Self.paged ? firstShown.flatMap { id in all.firstIndex { $0.id == id } } ?? max(0, all.count - Self.page) : 0
        let items = Array(all[start...])
        let moreOnComputer = !model.historyComplete.contains(botId) && thread.count >= 50
        ScrollView {
            // Not lazy: only a page or a few render, and lazy rows of very different heights
            // (long replies) mis-estimate on the way to the bottom and can leave it blank.
            VStack(alignment: .leading, spacing: 0) {
                if start > 0 || moreOnComputer {
                    Spinner(size: 14)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .onChange(of: following) { _, _ in showEarlier() }
                        .accessibilityLabel("Loading earlier messages")
                }
                if all.isEmpty, let bot {
                    if bot.isGroup { GroupIntroCard(group: bot).padding(.top, 40) } else { IntroCard(bot: bot).padding(.top, 40) }
                }
                ForEach(items) { item in
                    row(item)
                        .id(item.id)
                        .transition(item.id == items.last?.id
                            ? .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)
                            : .identity)
                }
                // Offline, "working" is only what the computer last said; don't show it as live.
                if let bot, bot.isWorking(in: botId, thread: nil), !model.isOffline {
                    WorkingIndicator(bot: bot, thinking: model.currentThinking(botId, thread: nil))
                        .padding(.top, 6)
                        .id("working")
                        .transition(.opacity)
                }
                Color.clear.frame(height: 8).id("bottom")
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .animation(Motion.reduced(Motion.conversation, reduceMotion), value: items.last?.id)
            .animation(Motion.reduced(Motion.layout, reduceMotion), value: bot?.isWorking(in: botId, thread: nil))
        }
        .scrollIndicators(.never)
        .nearTop { near in
            topVisible = near
            showEarlier()
        }
        .followsConversation($following, keepingPlace: $keepingPlace)
        .scrollDismissesKeyboard(.interactively)
        .conversationScrollEdges()
        .simultaneousGesture(TapGesture().onEnded { dismissChatKeyboard() })
        .onChange(of: items.last?.id) { _, _ in
            // Sending brings the chat back down to your message.
            if items.last?.isUserMessage == true { following = true }
        }
        .overlay(alignment: .bottom) {
            JumpToLatest(visible: !following && !items.isEmpty) { following = true }
        }
        .onAppear { if firstShown == nil { firstShown = items.first?.id } }
    }

    /// The reader scrolled up to the top: render the previous page, fetching it from the
    /// computer when this device has no more. The message they were on keeps its place.
    private func showEarlier() {
        guard topVisible, !following, !loadingEarlier else { return }
        loadingEarlier = true
        Task {
            var list = ChatItem.build(model.chat(botId), streaming: streaming, steady: true)
            var start = firstShown.flatMap { id in list.firstIndex { $0.id == id } } ?? max(0, list.count - Self.page)
            if start == 0 {
                let anchor = list.first?.id
                await model.loadOlder(botId)
                list = ChatItem.build(model.chat(botId), streaming: streaming, steady: true)
                start = anchor.flatMap { id in list.firstIndex { $0.id == id } } ?? 0
            }
            guard start > 0 else {
                loadingEarlier = false
                return
            }
            keepingPlace = list[start].id
            firstShown = list[max(0, start - Self.page)].id
            // Rows above settle over a few layout passes.
            try? await Task.sleep(for: .milliseconds(400))
            keepingPlace = nil
            loadingEarlier = false
            // Still at the top with more to show: keep going.
            showEarlier()
        }
    }

    /// The system navigation bar: the title pill holds the bot's actions; the corner is the computer.
    func platformChrome(_ content: some View) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        header
                        connectionSubtitle
                    }
                }
                if model.screen != nil {
                    ToolbarItem(placement: .topBarTrailing) { computerButton }
                }
            }
    }

    var header: some View {
        // Like Grok Bot: the title pill holds the bot's actions; the corner is the computer.
        Menu {
            Text("\(model.hostName) · \(model.connectionLabel)")
            Button("Reconnect", systemImage: "arrow.clockwise") { model.restartStream() }
            Divider()
            Button("Details", systemImage: "info.circle", action: openDetails)
            ForEach(menuItems) { item in
                if item.divider { Divider() }
                Button(role: item.destructive ? .destructive : nil, action: item.action) {
                    if let icon = item.icon { Label(item.title, systemImage: icon) } else { Text(item.title) }
                }
            }
        } label: {
            title
        }
        .accessibilityLabel("\(bot?.name ?? "Conversation") actions")
    }

    private func openDetails() {
        if bot?.isGroup == true { editingGroup = true } else if let bot { editing = EditorRequest(BotDraft(bot)) }
    }

    /// Opens the computer's screen; pulses while this bot is operating it (watch, then take over).
    private var computerButton: some View {
        let operating = model.screen?.agentBot == botId
        return Button("Computer", systemImage: "desktopcomputer") {
            model.screenRequest = operating ? ScreenRequest(watching: botId) : ScreenRequest()
        }
        .symbolEffect(.pulse, options: .repeating, isActive: operating)
    }

    func dismissChatKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    func presentRoutine() {
        showRoutines = true
    }

    func editProfile(_ bot: Bot) {
        editing = EditorRequest(BotDraft(bot))
    }
}
