import KithKit
import SwiftUI

/// A bot's routines; a row opens its editor.
struct RoutinesView: View {
    let botId: String
    var initialId: String?
    /// Goes back to the chat once a request to the bot is in the composer.
    var leave: (() -> Void)?
    /// The kith bot's own schedules: read-only rows in the same list.
    var kithSchedules: [KithSchedule] = []
    var schedulesUnreadable = false
    var botName = "the bot"
    @Environment(BotStore.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var routines: [Routine] = []
    @State private var runs: [RoutineRun] = []
    /// The open editor: on a routine, or (`routineId` nil) setting up a new one.
    @State private var editing: EditorTarget?
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?
    @State private var loadError: String?

    var body: some View {
        CardSection("Schedules & routines") {
            listing
            if schedulesUnreadable { SheetNote(text: "Couldn't read kith's schedules") }
            ForEach(kithSchedules) { KithScheduleRow(job: $0) }
            Button { edit("I want a routine that ") } label: {
                SheetRow(icon: "sparkles", title: "Ask \(botName) for a routine", accent: true)
            }
            .buttonStyle(.plain)
            .disabled(model.isOffline)
            if let loadError { SheetNote(text: loadError, danger: true) { Task { await load() } } }
            if let error { SheetNote(text: error, danger: true) }
        } accessory: {
            IconButton("Set up a routine", systemImage: "plus") { open(nil) }
                .disabled(model.isOffline)
        }
        .foregroundStyle(Palette.text)
        .font(.system(size: 13))
        .onChange(of: initialId) { _, id in
            if let id { open(id) }
        }
        .task(id: botId) {
            if let initialId { open(initialId) }
            repeat {
                await load()
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            } while !Task.isCancelled
        }
        // Item-based, so the editor always gets the routine it was opened on.
        .kithSheet(item: $editing) { target in
            RoutineEditorView(botId: botId, routine: routines.first { $0.id == target.routineId }) { saved in
                if let i = routines.firstIndex(where: { $0.id == saved?.id }), let saved { routines[i] = saved }
                else if let saved { routines.append(saved) }
                // A new webhook routine stays open: its URL and key exist only now.
                if target.routineId == nil, let saved, saved.triggers.contains(where: { $0.type == "webhook" }) {
                    editing = EditorTarget(id: target.id, routineId: saved.id)
                } else {
                    animate { editing = nil }
                }
                Task { await load() }
            }
        }
    }

    @ViewBuilder private var listing: some View {
        if routines.isEmpty, kithSchedules.isEmpty {
            SheetNote(text: loaded ? "No routines yet. Ask the bot for one, or set it up yourself with +." : "Loading routines…")
        }
        ForEach(routines) { routine in row(routine) }
    }

    private func row(_ routine: Routine) -> some View {
        HStack(spacing: 12) {
            Button { open(routine.id) } label: {
                SheetRow(icon: "clock", title: routine.name, detail: summary(routine))
            }
            .buttonStyle(.plain)
            Toggle(isOn: Binding(get: { routine.enabled }, set: { action("setRoutineEnabled", routine, enabled: $0) })) { EmptyView() }
                .toggleStyle(.kith)
                .fixedSize()
                .accessibilityLabel(routine.name)
                .disabled(busy || model.isOffline)
        }
    }

    /// The row's second line: what's happening now, else when it runs.
    private func summary(_ routine: Routine) -> String {
        if let active = runs.first(where: { $0.routineId == routine.id && $0.isActive }) { return runLabel(active) }
        if routine.lastError != nil { return "Schedule needs attention" }
        if let last = runs.first(where: { $0.routineId == routine.id }), ["failed", "interrupted"].contains(last.status) {
            return "Last run \(runLabel(last).lowercased())"
        }
        return routine.triggerDescriptions.joined(separator: " · ")
    }

    private func runLabel(_ run: RoutineRun) -> String {
        switch run.status {
        case "pending": "Queued"
        case "starting": "Starting"
        case "running": "Running"
        case "recovering": "Resuming after restart"
        case "failed": "Failed"
        case "interrupted": "Interrupted"
        default: run.status.capitalized
        }
    }

    private func animate(_ change: () -> Void) { withAnimation(Motion.reduced(Motion.layout, reduceMotion), change) }
    private func open(_ id: String?) { animate { editing = EditorTarget(id: UUID().uuidString, routineId: id) } }
    private func edit(_ text: String) {
        animate {
            model.routineDrafts[botId] = text
            leave?()
        }
    }
    private func action(_ method: String, _ routine: Routine, enabled: Bool? = nil) {
        guard !busy, let client = model.client else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.routineAction(method, botId: botId, id: routine.id, enabled: enabled)
                error = nil
                await load()
            } catch { self.error = error.localizedDescription }
        }
    }
    private func load() async {
        guard let client = model.client else { return }
        do {
            let result = try await client.routines(botId: botId)
            routines = result.routines
            runs = result.runs
            loaded = true
            loadError = nil
        } catch is CancellationError {} catch { self.loadError = error.localizedDescription }
    }
}

private struct EditorTarget: Identifiable {
    /// One per opening; kept when a new routine is saved and the editor stays on it.
    let id: String
    let routineId: String?
}
