import CodyncKit
import SwiftUI

/// A bot's memory: what all your bots know about you, what this one knows, its dreams and its project's notes.
struct MemoryCard: View {
    let botId: String
    @Environment(BotStore.self) private var host
    @State private var memory: MemoryStore?
    @State private var section: Section = .bot
    @State private var editor: MemoryEditTarget?
    @State private var confirmClear = false

    enum Section: Hashable { case yours, bot, dreams, project }

    private var bot: Bot? { host.bots[botId] }

    var body: some View {
        CardSection("Memory") {
            if let memory { contents(memory) }
            else { Text("Loading memory…").foregroundStyle(Palette.secondary) }
        } accessory: {
            if let memory, section == .yours || section == .bot {
                HStack(spacing: 2) {
                    IconButton("Add memory", systemImage: "plus") {
                        withAnimation(Motion.layout) { editor = MemoryEditTarget(entry: nil, shared: section == .yours, text: "") }
                    }
                    .disabled(memory.busy)
                    moreMenu(memory)
                }
            }
        }
        // Memory changes anywhere move the bot's `memoryRev`: fetch again.
        .task(id: "\(botId)-\(bot?.memoryRev ?? 0)-\(bot?.sharedMemory ?? false)") {
            let store = memory ?? MemoryStore(botId: botId) { try await host.ready() }
            memory = store
            await store.load()
        }
        .codyncSheet(item: $editor) { target in
            if let memory { MemoryEditorView(memory: memory, target: target) }
        }
        .codyncDialog(section == .yours ? "Forget everything your bots share about you?" : "Forget everything this bot remembers?",
                      isPresented: $confirmClear) {
            [DialogAction("Forget everything", destructive: true) {
                Task { await memory?.mutate("clearMemory", shared: section == .yours) }
            }]
        }
    }

    @ViewBuilder private func contents(_ memory: MemoryStore) -> some View {
        SegmentedChoice(selection: Binding(get: { section }, set: { value in withAnimation(Motion.layout) { section = value } }),
                        options: sections(memory.view))
        if let error = memory.error { Text(error).foregroundStyle(Palette.danger).textSelection(.enabled) }
        if let view = memory.view {
            switch section {
            case .yours, .bot: layer(memory, view: view)
            case .dreams: dreams(memory, view.dreams)
            case .project: project(view.projectMemory)
            }
        } else if memory.error == nil {
            Text("Loading memory…").foregroundStyle(Palette.secondary)
        }
    }

    private func sections(_ view: MemoryView?) -> [(id: Section, label: String)] {
        [(Section.yours, "About you"), (.bot, "This bot"), (.dreams, "Dreams")]
            + (view?.projectMemory != nil ? [(.project, "Project")] : [])
    }

    @ViewBuilder private func layer(_ memory: MemoryStore, view: MemoryView) -> some View {
        let shared = section == .yours
        let layer = shared ? view.yours : view.bot
        if shared, let bot {
            Toggle("Use what your bots share", isOn: Binding(get: { bot.sharedMemory ?? view.shared }, set: { host.setSharedMemory(bot, $0) }))
                .toggleStyle(.codync)
        }
        Text("\(shared ? "Your name, time zone, people and lasting preferences, shared by your bots." : "What this bot learned about you.") \(layer.used) of \(layer.cap) in use.")
            .font(.footnote).foregroundStyle(Palette.secondary)
        if layer.entries.isEmpty {
            empty("brain", shared ? "Nothing shared yet." : "Nothing yet. What this bot learns about you shows up here, and you can change any of it.")
        }
        ForEach(layer.entries) { entry in
            HStack(alignment: .top, spacing: 8) {
                Button {
                    withAnimation(Motion.layout) { editor = MemoryEditTarget(entry: entry.id, shared: shared, text: entry.text) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if entry.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Palette.secondary) }
                            Text(entry.text).foregroundStyle(entry.archived ? Palette.tertiary : Palette.text)
                        }
                        Text("\(author(entry)) · \(Date(milliseconds: entry.updatedAt).formatted(.relative(presentation: .named)))\(entry.archived ? " · archived" : "")")
                            .font(.caption).foregroundStyle(Palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                entryMenu(memory, entry, shared: shared)
            }
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder private func dreams(_ memory: MemoryStore, _ runs: [DreamRun]) -> some View {
        Text("Between chats the bot tidies its memory from your own words. Each run can be undone.")
            .font(.footnote).foregroundStyle(Palette.secondary)
        if runs.isEmpty { empty("moon", "No dreams yet.") }
        ForEach(runs) { run in
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Date(milliseconds: run.at).formatted(.relative(presentation: .named)))\(run.undone ? " · undone" : "")")
                        .fontWeight(.semibold)
                    ForEach(run.added, id: \.id) { Text("+ \($0.text)") }
                    ForEach(run.archived, id: \.id) { Text("− \($0.text)").foregroundStyle(Palette.tertiary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !run.undone {
                    IconButton("Undo this dream", systemImage: "arrow.uturn.backward") {
                        Task { await memory.mutate("undoDream", id: run.id) }
                    }
                    .disabled(memory.busy)
                }
            }
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder private func project(_ project: MemoryView.Project?) -> some View {
        if let project {
            Text("The project folder's own notes, kept by Claude Code. Read-only here.")
                .font(.footnote).foregroundStyle(Palette.secondary)
            Text(project.path).font(.caption).foregroundStyle(Palette.tertiary).textSelection(.enabled)
            Text(project.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func empty(_ icon: String, _ text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.title3).foregroundStyle(Palette.tertiary)
            Text(text).multilineTextAlignment(.center).foregroundStyle(Palette.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }

    private func author(_ entry: MemoryEntry) -> String {
        switch entry.author {
        case "user": "You wrote it"
        case "bot": "\(host.bots[entry.authorBot ?? ""]?.name ?? "A bot") remembered it"
        case "dream": "Dreaming"
        default: "Moved from the old memory"
        }
    }

    private func moreMenu(_ memory: MemoryStore) -> some View {
        DropdownMenu {
            [MenuItem("Refresh", icon: "arrow.clockwise") { Task { await memory.load() } },
             MenuItem("Forget everything here", icon: "trash", destructive: true, divider: true) {
                 withAnimation(Motion.layout) { confirmClear = true }
             }]
        } label: { menuLabel("More") }
    }

    private func entryMenu(_ memory: MemoryStore, _ entry: MemoryEntry, shared: Bool) -> some View {
        DropdownMenu {
            [MenuItem("Edit", icon: "pencil") {
                withAnimation(Motion.layout) { editor = MemoryEditTarget(entry: entry.id, shared: shared, text: entry.text) }
            },
             MenuItem(entry.pinned ? "Unpin" : "Pin", icon: entry.pinned ? "pin.slash" : "pin") {
                 Task { await memory.mutate("pinMemory", id: entry.id, pinned: !entry.pinned) }
             },
             MenuItem(entry.archived ? "Bring back" : "Archive", icon: entry.archived ? "tray.and.arrow.up" : "archivebox") {
                 Task { await memory.mutate("archiveMemory", id: entry.id, archived: !entry.archived) }
             },
             MenuItem("Forget", icon: "trash", destructive: true, divider: true) {
                 Task { await memory.mutate("forgetMemory", id: entry.id) }
             }]
        } label: { menuLabel("Memory actions") }
        .disabled(memory.busy)
    }

    private func menuLabel(_ title: String) -> some View {
        Image(systemName: "ellipsis")
            .font(.body.weight(.medium))
            .foregroundStyle(Palette.secondary)
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
            .accessibilityLabel(title)
    }
}
