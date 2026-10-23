import KithKit
import SwiftUI

/// A plain bot's Memory page, as the mock's phone 5 draws it: the two switches, the entries (long-press for
/// Edit / Pin / Archive / Forget), and a MORE group with the notes files, the harness's own notes and the tidy runs.
struct MemoryCard: View {
    let botId: String
    /// False on an hq bot whose kith "Agent memory" lists the agent's files already.
    var showsHarnessTab = true
    @Environment(BotStore.self) private var host
    @State private var memory: MemoryStore?
    @State private var editor: MemoryEditTarget?
    /// Which layer the "Forget everything" dialog is about (true: what the user's bots share); nil: closed.
    @State private var confirmClear: Bool?
    @State private var aboutHarness = false

    private var bot: Bot? { host.bots[botId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let memory { contents(memory) }
            else { CardSection { SheetNote(text: "Loading memory…") } }
        }
        // Memory changes anywhere move the bot's `memoryRev`: fetch again.
        .task(id: "\(botId)-\(bot?.memoryRev ?? 0)-\(bot?.sharedMemory ?? false)-\(bot?.harnessMemory ?? false)") {
            let store = memory ?? MemoryStore(botId: botId) { try await host.ready() }
            memory = store
            await store.load()
        }
        .kithSheet(isPresented: $aboutHarness) {
            if let bot { HarnessMemorySheet(harness: host.backendName(bot.backend), readable: bot.backend == "claude") }
        }
        .kithSheet(item: $editor) { target in
            if let memory { MemoryEditorView(memory: memory, target: target) }
        }
        .kithDialog(confirmClear == true ? "Forget everything your bots share about you?" : "Forget everything this bot remembers?",
                      isPresented: Binding(get: { confirmClear != nil }, set: { if !$0 { confirmClear = nil } })) {
            [DialogAction("Forget everything", destructive: true) {
                let shared = confirmClear == true
                Task { await memory?.mutate("clearMemory", shared: shared) }
            }]
        }
    }

    @ViewBuilder private func contents(_ memory: MemoryStore) -> some View {
        if let error = memory.error { SheetNote(text: error, danger: true) }
        if let view = memory.view {
            switches(memory, view)
            entries(memory, view, shared: false)
            if (bot?.sharedMemory ?? view.shared) || !view.yours.entries.isEmpty {
                entries(memory, view, shared: true)
            }
            more(memory, view)
        } else if memory.error == nil {
            CardSection { SheetNote(text: "Loading memory…") }
        }
    }

    // MARK: switches

    @ViewBuilder private func switches(_ memory: MemoryStore, _ view: MemoryView) -> some View {
        if let bot {
            CardSection {
                SwitchRow("Use what your bots share", detail: "Your name, time zone, people and lasting preferences",
                          isOn: Binding(get: { bot.sharedMemory ?? view.shared }, set: { host.setSharedMemory(bot, $0) }))
                if let on = bot.harnessMemory {
                    let name = host.backendName(bot.backend)
                    HStack(spacing: 4) {
                        SwitchRow("Own memory", detail: "\(name) keeps notes from your chats",
                                  isOn: Binding(get: { on }, set: { host.setHarnessMemory(bot, $0) }))
                            .disabled(memory.busy)
                        IconButton("About \(name)'s own memory", systemImage: "info.circle") {
                            withAnimation(Motion.layout) { aboutHarness = true }
                        }
                    }
                }
            }
        }
    }

    // MARK: entries

    @ViewBuilder private func entries(_ memory: MemoryStore, _ view: MemoryView, shared: Bool) -> some View {
        let layer = shared ? view.yours : view.bot
        CardSection(shared ? "Shared entries" : "Entries", footer: "\(layer.used) of \(layer.cap) in use.") {
            if layer.entries.isEmpty {
                SheetNote(text: shared ? "Nothing shared yet."
                          : "Nothing yet. What this bot learns about you shows up here, and you can change any of it.")
                    .padding(.vertical, 6)
            }
            ForEach(layer.entries) { entry in entryRow(memory, entry, shared: shared) }
        } accessory: {
            HStack(spacing: 2) {
                IconButton("Add memory", systemImage: "plus") {
                    withAnimation(Motion.layout) { editor = MemoryEditTarget(entry: nil, shared: shared, text: "") }
                }
                .disabled(memory.busy)
                moreMenu(memory, shared: shared)
            }
        }
    }

    private func entryRow(_ memory: MemoryStore, _ entry: MemoryEntry, shared: Bool) -> some View {
        let when = Date(milliseconds: entry.updatedAt).formatted(.relative(presentation: .named))
        return Button {
            withAnimation(Motion.layout) { editor = MemoryEditTarget(entry: entry.id, shared: shared, text: entry.text) }
        } label: {
            SheetRow(icon: entry.pinned ? "pin.fill" : "lightbulb", title: entry.text,
                     detail: "\(author(entry)) · \(when)\(entry.archived ? " · archived" : "")")
                .opacity(entry.archived ? 0.6 : 1)
                .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .disabled(memory.busy)
        .contextActions {
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
        }
    }

    // MARK: more

    @ViewBuilder private func more(_ memory: MemoryStore, _ view: MemoryView) -> some View {
        CardSection("More") {
            if let files = view.files {
                let live = (files.bot.files + files.yours.files).filter { !$0.deleted }.count
                SheetCountRow(icon: "doc.text", title: "Notes files", count: live) {
                    MemoryFilesList(memory: memory, files: files, shared: false)
                    if (bot?.sharedMemory ?? view.shared) || !files.yours.files.isEmpty {
                        Text("Shared notes").font(.footnote.weight(.semibold)).foregroundStyle(Palette.secondary)
                        MemoryFilesList(memory: memory, files: files, shared: true)
                    }
                }
            }
            if showsHarnessTab, let project = view.projectMemory {
                SheetCountRow(icon: "brain", title: "\(host.backendName(bot?.backend ?? "claude")) memory (read-only)", count: nil) {
                    harness(project)
                }
            }
            SheetCountRow(icon: "sparkles", title: "Tidy runs", count: view.tidyUps.count) {
                tidyUps(memory, view.tidyUps)
            }
        }
    }

    @ViewBuilder private func tidyUps(_ memory: MemoryStore, _ runs: [TidyRun]) -> some View {
        Text("Between chats the bot tidies its memory from your own words. Each run can be undone.")
            .font(.footnote).foregroundStyle(Palette.secondary)
        if runs.isEmpty { SheetNote(text: "No tidy-ups yet.") }
        ForEach(runs) { run in
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Date(milliseconds: run.at).formatted(.relative(presentation: .named)))\(run.undone ? " · undone" : "")")
                        .fontWeight(.semibold)
                    ForEach(run.added, id: \.id) { Text("+ \($0.text)") }
                    ForEach(run.archived, id: \.id) { Text("− \($0.text)").foregroundStyle(Palette.tertiary) }
                    ForEach(run.files ?? [], id: \.version) { Label("Added to \($0.name)", systemImage: "doc.text").foregroundStyle(Palette.secondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !run.undone {
                    IconButton("Undo this tidy", systemImage: "arrow.uturn.backward") {
                        Task { await memory.mutate("undoTidy", id: run.id) }
                    }
                    .disabled(memory.busy)
                }
            }
        }
    }

    @ViewBuilder private func harness(_ project: MemoryView.Project) -> some View {
        Text("\(host.backendName(bot?.backend ?? "claude"))'s own notes, read-only here.")
            .font(.footnote).foregroundStyle(Palette.secondary)
        Text(project.path).font(.caption).foregroundStyle(Palette.tertiary).textSelection(.enabled)
        if project.text.isEmpty { SheetNote(text: "Nothing yet. The notes show up here once it saves some.") }
        else { Text(project.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
    }

    private func author(_ entry: MemoryEntry) -> String {
        switch entry.author {
        case "user": "You wrote it"
        case "bot": "\(host.bots[entry.authorBot ?? ""]?.name ?? "A bot") remembered it"
        case "tidy", "dream": "Tidying up"
        default: "Moved from the old memory"
        }
    }

    private func moreMenu(_ memory: MemoryStore, shared: Bool) -> some View {
        DropdownMenu {
            [MenuItem("Refresh", icon: "arrow.clockwise") { Task { await memory.load() } },
             MenuItem("Forget everything here", icon: "trash", destructive: true, divider: true) {
                 withAnimation(Motion.layout) { confirmClear = shared }
             }]
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.medium))
                .foregroundStyle(Palette.secondary)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
                .accessibilityLabel("More")
        }
    }
}
