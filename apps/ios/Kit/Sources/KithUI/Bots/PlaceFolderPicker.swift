import KithKit
import SwiftUI

/// Picks the project or folder a place works in: hq's projects, recent folders, then any folder on the computer.
/// A folder that isn't a project can be registered as one on the way.
struct PlaceFolderPicker: View {
    /// What the place works in now, to mark it.
    let current: PlaceFolder?
    /// "Use default" (clear) is offered: the place has its own pick to forget.
    var offersDefault: Bool
    /// Called with the choice; nil means the default. The sheet closes after.
    let onChoose: (FolderChoice?) -> Void

    @Environment(BotStore.self) private var model
    @Environment(\.dismissModal) private var dismiss
    @State private var projects: ProjectList?
    @State private var recent: [RecentFolder] = []
    @State private var loadError: String?
    @State private var browsing = false
    @State private var registering: String?

    var body: some View {
        Group {
            if let registering {
                RegisterProjectView(path: registering, back: { self.registering = nil }) { choice in finish(choice) }
            } else if browsing {
                FolderPicker(start: nil, onExit: { browsing = false }) { path, project in
                    if let project { finish(.project(project)) } else { registering = path }
                }
            } else {
                list
            }
        }
        .background(Palette.background)
        .task { await load() }
    }

    private func finish(_ choice: FolderChoice?) {
        onChoose(choice)
        dismiss()
    }

    private var list: some View {
        VStack(spacing: 0) {
            ModalHeader("Working folder")
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if offersDefault {
                        CardSection {
                            row("Use default", detail: "What the bot works in unless told otherwise", icon: "arrow.uturn.backward") { finish(nil) }
                        }
                    }
                    projectsSection
                    if !recent.isEmpty {
                        CardSection("Recent") {
                            ForEach(recent) { item in
                                row(item.name, detail: item.project == nil ? item.path : "Project", icon: item.project == nil ? "folder" : "shippingbox",
                                    selected: current?.inherited == false && current?.path == item.path) {
                                    finish(item.project.map(FolderChoice.project) ?? .folder(item.path))
                                }
                            }
                        }
                    }
                    CardSection {
                        row("Choose folder…", detail: "Browse this computer", icon: "folder.badge.plus", chevron: true) { browsing = true }
                    }
                    if let loadError {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(loadError).font(.footnote).foregroundStyle(Palette.danger)
                            Button("Try again") { Task { await load(refresh: true) } }
                                .font(.footnote).foregroundStyle(Palette.accent)
                        }
                    }
                }
                .font(.body)
                .padding(20)
            }
        }
    }

    @ViewBuilder private var projectsSection: some View {
        if let projects {
            if projects.projects.isEmpty {
                // hq missing or failing: folders below still work.
                Text(projects.error.map { "hq projects aren't available: \($0)" } ?? "No hq projects yet.")
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
            } else {
                CardSection("hq projects") {
                    ForEach(projects.projects) { project in
                        row(project.id,
                            detail: project.exists ? project.path.map { ($0 as NSString).abbreviatingWithTildeInPath } : "Not on this computer",
                            icon: "shippingbox",
                            selected: current?.project == project.id && current?.inherited == false,
                            disabled: !project.exists) { finish(.project(project.id)) }
                    }
                }
            }
        } else if loadError == nil {
            Spinner(size: 20).frame(maxWidth: .infinity)
        }
    }

    private func row(_ title: String, detail: String?, icon: String, selected: Bool = false, chevron: Bool = false, disabled: Bool = false,
                     action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).foregroundStyle(selected ? Palette.accent : Palette.secondary).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Palette.text).lineLimit(1)
                    if let detail {
                        Text(detail).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if selected { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
                if chevron {
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Palette.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScale())
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
    }

    private func load(refresh: Bool = false) async {
        loadError = nil
        do {
            async let list = model.projects(refresh: refresh)
            async let folders = model.recentFolders()
            // Recent folders are a convenience: an older host without them still gets the rest.
            projects = try await list
            recent = (try? await folders) ?? []
        } catch {
            loadError = error.localizedDescription
            projects = projects ?? ProjectList()
        }
    }
}

/// "Register as hq project": names a folder so hq (and the agent) know it, with an id prefilled from the folder.
private struct RegisterProjectView: View {
    let path: String
    let back: () -> Void
    let done: (FolderChoice) -> Void
    @Environment(BotStore.self) private var model
    @State private var id: String
    @State private var busy = false
    @State private var error: String?

    init(path: String, back: @escaping () -> Void, done: @escaping (FolderChoice) -> Void) {
        self.path = path
        self.back = back
        self.done = done
        _id = State(initialValue: Self.suggestedId(for: path))
    }

    /// Lowercase words joined by single dashes, as hq wants a project id.
    static func suggestedId(for path: String) -> String {
        let name = (path as NSString).lastPathComponent.lowercased()
        let words = name.split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }
        return words.joined(separator: "-")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                BackButton(action: back).padding(.leading, 12)
                ModalHeader("Register project")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("“\((path as NSString).lastPathComponent)” isn't an hq project yet. Registering it lets the agent load its context (CLAUDE.md, notes, memory) the way `hq -p` does.")
                        .font(.subheadline)
                        .foregroundStyle(Palette.secondary)
                    CardSection("Project id", footer: path) {
                        TextField("project-id", text: $id)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .foregroundStyle(Palette.text)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Palette.danger) }
                    Button {
                        Task { await register() }
                    } label: {
                        HStack {
                            if busy { Spinner(size: 16) }
                            Text("Register and use").font(.headline)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .foregroundStyle(Palette.onAccent)
                        .background(Palette.accentFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(PressScale())
                    .disabled(busy || id.isEmpty)
                    Button("Just use the folder") { done(.folder(path)) }
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Palette.accent)
                        .disabled(busy)
                }
                .font(.body)
                .padding(20)
            }
        }
    }

    private func register() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let project = try await model.registerProject(id: id, path: path)
            done(.project(project.id))
        } catch {
            // hq's own words, e.g. when the id exists.
            self.error = error.localizedDescription
        }
    }
}

/// The folder a place works in, as a small button: its name, kind, and a warning when the folder is gone.
/// Tapping opens the picker; a change that matters (a chat with messages) asks first, since it starts a fresh session.
struct PlaceFolderChip: View {
    let botId: String
    /// The thread's root message; nil for the bot's own chat.
    var thread: String?
    @Environment(BotStore.self) private var model
    @State private var picking = false
    @State private var pending: PendingChoice?

    struct PendingChoice { let choice: FolderChoice? }

    private var bot: Bot? { model.bots[botId] }
    private var folder: PlaceFolder? { model.placeFolder(botId, thread: thread) }
    private var hasMessages: Bool {
        // A thread has its root message, so a change there always starts over something.
        thread != nil || !model.chat(botId).isEmpty
    }

    var body: some View {
        Group {
            if let folder, bot?.isGroup != true {
                Button { picking = true } label: { label(folder) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Working folder: \(folder.name)\(folder.missing ? ", missing" : "")")
                    .accessibilityHint("Choose another folder")
            }
        }
        .kithSheet(isPresented: $picking) {
            PlaceFolderPicker(current: folder, offersDefault: folder?.inherited == false) { choice in
                if hasMessages {
                    // After the sheet has gone, or the dialog would have nothing to appear over.
                    Task {
                        try? await Task.sleep(for: .milliseconds(450))
                        pending = PendingChoice(choice: choice)
                    }
                } else {
                    apply(choice)
                }
            }
        }
        .kithDialog("Switch folder?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                      message: (bot?.isWorking(in: botId, thread: thread) == true ? "This stops what it is doing. " : "")
                          + "The conversation stays here, but the agent starts a fresh session in the new folder.") {
            [DialogAction("Switch") { if let pending { apply(pending.choice) } }]
        }
    }

    private func label(_ folder: PlaceFolder) -> some View {
        HStack(spacing: 4) {
            Image(systemName: folder.missing ? "exclamationmark.triangle.fill" : folder.icon).font(.system(size: 10))
            Text(folder.name).lineLimit(1).truncationMode(.middle)
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
        }
        .font(.system(size: 11, weight: .medium))
        // An inherited folder is the default, so it reads quieter than one picked for this place.
        .foregroundStyle(folder.missing ? Palette.warning : folder.inherited ? Palette.tertiary : Palette.accent)
        .contentShape(Rectangle())
    }

    private func apply(_ choice: FolderChoice?) {
        Task {
            do { try await model.setPlaceFolder(botId, thread: thread, to: choice) } catch {
                model.lastError = "Couldn't change the folder: \(error.localizedDescription)"
            }
        }
    }
}
