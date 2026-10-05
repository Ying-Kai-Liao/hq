import CodyncKit
import SwiftUI

/// A bot's routines; a row opens its editor.
struct RoutinesView: View {
    let botId: String
    var initialId: String?
    var close: (() -> Void)?
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
        VStack(alignment: .leading, spacing: close == nil ? 10 : 16) {
            HStack {
                Text("Routines")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.text)
                    .padding(.leading, 2)
                Spacer(minLength: 0)
                askInChat
                IconButton("Set up a routine", systemImage: "plus") { open(nil) }
                    .disabled(model.isOffline)
                if let close { IconButton("Close routines", systemImage: "xmark", action: close) }
            }
            if let loadError { Text(loadError).font(.caption).foregroundStyle(Palette.danger) }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            listing
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
        .codyncSheet(item: $editing) { target in
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

    private var listing: some View {
        VStack(alignment: .leading, spacing: 0) {
            if routines.isEmpty {
                Text(loaded ? "No routines yet. Ask the bot for one, or set it up yourself with +." : "Loading routines…")
                    .font(.system(size: 12))
                    .lineSpacing(3)
                    .foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                VStack(spacing: 0) {
                    ForEach(routines) { routine in
                        if routine.id != routines.first?.id { Hairline() }
                        row(routine)
                    }
                }
                .padding(.horizontal, 14)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
    }

    private func row(_ routine: Routine) -> some View {
        HStack(spacing: 12) {
            Button { open(routine.id) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(routine.name).foregroundStyle(Palette.text)
                    Text(summary(routine))
                        .font(.caption)
                        .foregroundStyle(routine.lastError == nil ? Palette.secondary : Palette.danger)
                }
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Toggle(isOn: Binding(get: { routine.enabled }, set: { action("setRoutineEnabled", routine, enabled: $0) })) { EmptyView() }
                .toggleStyle(.codync)
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

    private var askInChat: some View {
        IconButton("Ask the bot for a routine", systemImage: "text.bubble") {
            edit("I want a routine that ")
        }
        .disabled(model.isOffline)
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
            close?()
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
