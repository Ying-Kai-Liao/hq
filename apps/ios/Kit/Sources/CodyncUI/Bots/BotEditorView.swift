import CodyncKit
import SwiftUI

public struct EditorRequest: Identifiable {
    public let id = UUID()
    public var draft: BotDraft

    public init(_ draft: BotDraft) { self.draft = draft }
}

/// Create or edit a bot in a modal (iPhone): the settings form plus Close / Save.
public struct BotEditorView: View {
    @Environment(BotStore.self) private var model
    @Environment(\.dismissModal) private var dismiss
    @State var draft: BotDraft
    private let computers: [(id: ComputerID, label: String)]
    private let computer: Binding<ComputerID>?

    /// `computer` lets a new bot pick which computer it runs on; the caller swaps the `BotStore` to match.
    public init(draft: BotDraft, computers: [(id: ComputerID, label: String)] = [], computer: Binding<ComputerID>? = nil) {
        _draft = State(initialValue: draft)
        self.computers = computers
        self.computer = computer
    }
    @State private var saving = false
    @State private var error: String?

    private var isNew: Bool { draft.id == nil }

    public var body: some View {
        VStack(spacing: 0) {
            ModalHeader(isNew ? "New bot" : "Settings") {
                if saving {
                    Spinner()
                } else {
                    IconButton(isNew ? "Create" : "Save", systemImage: "checkmark") { save() }
                        .disabled(!draft.isValid || saving || model.connection != .online)
                }
            }
            BotSettingsForm(draft: $draft, error: error, computers: computers, computer: computer)
        }
        .background(Palette.background)
        .onAppear { if isNew { model.fillDefaults(&draft) } }
        // A new bot's connectors and skills start on once the computer has listed them.
        .onChange(of: model.installedConnectors.map(\.id) + model.installedSkills.map(\.id)) {
            if isNew { model.fillDefaults(&draft) }
        }
        .onChange(of: model.computer.id) {
            // Folders, models and connectors belong to the old computer.
            draft.cwd = ""
            draft.model = nil
            draft.modelOptions = [:]
            draft.connectors = nil
            draft.skills = nil
            model.fillDefaults(&draft)
        }
    }

    private func save() {
        guard draft.isValid, !saving, model.connection == .online else { return }
        saving = true
        error = nil
        Task {
            do {
                let bot = try await model.save(draft.normalized)
                dismiss()
                if isNew { model.selection = bot.id }
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}

/// Which settings a form shows: all of them (a new bot), what changes often (instructions, model,
/// fast mode: the details sheet's Details page) or the rest (its Settings page).
enum FormPart {
    case all, often, rarely
}

/// Bot settings, in sections in the Settings style (`CardSection`). `scrolls` is off where a
/// surrounding view scrolls (the details sheet).
struct BotSettingsForm: View {
    @Binding var draft: BotDraft
    let error: String?
    var computers: [(id: ComputerID, label: String)] = []
    var computer: Binding<ComputerID>?
    var scrolls = true
    var part: FormPart = .all
    /// An hq bot's details sheet shows kith's copy of some facts: those cards go (`BotSections`).
    var shown = BotSections.all
    @Environment(BotStore.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pickingFolder = false
    /// hq's projects for the default-project menu; empty when the computer has no hq.
    @State private var hqProjects: [HQProject] = []
    @State private var pickingAvatar = false
    @State private var viewingSkill: SkillRef?

    var body: some View {
        Group {
            if scrolls {
                ScrollView { sections.padding(20) }
                    .scrollDismissesKeyboard(.interactively)
            } else {
                sections
            }
        }
        .font(.body)
        .background(Palette.background)
        .task { await model.refreshPlugins() }
        .task { hqProjects = (try? await model.projects().projects) ?? [] }
        .codyncSheet(item: $viewingSkill) { SkillSheet(skill: $0) }
        .codyncSheet(isPresented: $pickingFolder) {
            FolderPicker(start: draft.cwd.isEmpty ? model.hello?.home : draft.cwd) {
                draft.cwd = $0
                pickingFolder = false
            }
        }
    }

    /// What changes often: on the details sheet's Details page.
    private var oftenSections: some View {
        VStack(alignment: .leading, spacing: 30) {
            if shown.instructions { CardSection("Instructions") { instructions } }
            CardSection("Agent") {
                if shown.backendPicker { agentPicker }
                modelPicker
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(Palette.danger)
            }
        }
    }

    private var instructions: some View {
        Field("Standing instructions", detail: "Rules that always apply. Put task-specific requests in the chat instead.") {
            TextField("e.g. Reviews PRs. Never pushes without asking.", text: $draft.description, axis: .vertical)
                .lineLimit(3...8)
                .fieldBox()
        }
    }

    private var agentPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            ValueRow("Agent") {
                ChoicePicker(selection: $draft.backend,
                             options: (model.hello?.backends ?? []).map { ($0.id, $0.available ? $0.name : "\($0.name) (not installed)") } + [("custom", "Custom command")],
                             image: { id in AgentIcon.image(registry: model.hello?.backends.first { $0.id == id }?.registry ?? id) })
            }
            if let b = model.hello?.backends.first(where: { $0.id == draft.backend }), !b.available {
                Text(b.installHint).font(.caption).foregroundStyle(Palette.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if draft.backend == "custom" {
                TextField("ACP command, e.g. my-agent --acp", text: Binding(get: { draft.command ?? "" }, set: { draft.command = $0.isEmpty ? nil : $0 }))
                    .font(.callout.monospaced())
                    .plainTextInput()
                    .fieldBox()
            }
        }
    }

    private var modelPicker: some View {
        AgentModelPicker(backend: draft.backend, selection: $draft.model, options: $draft.modelOptions,
                         fastMode: Binding(get: { draft.fastMode ?? false }, set: { on in
                             withAnimation(Motion.reduced(Motion.fade, reduceMotion)) { draft.fastMode = on }
                         }), bot: draft.id.flatMap { model.bots[$0] })
    }

    @ViewBuilder private var sections: some View {
        if part == .often { oftenSections } else { allSections }
    }

    /// The body the avatar shows now.
    private var draftPortrait: String? {
        CrewAvatar.asset(for: draft, isGroup: model.bots[draft.id ?? ""]?.isGroup ?? false)
    }

    private var allSections: some View {
        VStack(alignment: .leading, spacing: 30) {
            CardSection("Profile") {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { pickingAvatar.toggle() }
                    } label: {
                        ValueRow("Avatar") {
                            CharacterAvatar(portrait: draftPortrait, color: draft.avatarColor, size: 28, id: draft.id ?? "")
                            .padding(5)
                            .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit Bot avatar")
                    if pickingAvatar {
                        AvatarPicker(draft: $draft, automatic: CrewAvatar.asset(source: "auto", id: draft.id ?? "", name: draft.name, isGroup: false))
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                // A new bot is named from its first conversations (Grok Bot's flow); rename it any time after.
                if draft.id != nil {
                    Field("Name") {
                        TextField("Name", text: $draft.name).fieldBox()
                    }
                }
                if part == .all { instructions }
            }

            // On the details sheet the agent and its model are on the Details page; what's left is where it works.
            CardSection(part == .all ? "Agent" : "Workspace") {
                VStack(alignment: .leading, spacing: 6) {
                    ValueRow("Computer") {
                        if let computer {
                            ChoicePicker(selection: computer, options: computers, fitsAvailableWidth: true)
                                .accessibilityLabel("Computer")
                        } else {
                            Text(model.hostName).lineLimit(1)
                        }
                    }
                    if computer != nil, model.connection != .online {
                        Text("Connect this computer to create the bot, or choose another computer.")
                            .font(.caption).foregroundStyle(Palette.warning)
                    }
                }
                if part == .all {
                    agentPicker
                    modelPicker
                }
                ValueRow("Workspace", detail: draft.cwd.isEmpty
                         ? "This bot has its own space for files. It can work in other folders when you ask."
                         : "This project is the default starting folder. The bot can work elsewhere when you ask.") {
                    DropdownMenu {
                        [
                            MenuItem("Personal workspace", selected: draft.cwd.isEmpty) {
                                withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { draft.cwd = "" }
                            },
                            MenuItem("Choose project folder…", selected: !draft.cwd.isEmpty) {
                                withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { pickingFolder = true }
                            },
                        ]
                    } label: {
                        HStack(spacing: 6) {
                            Text(draft.cwd.isEmpty ? "Personal" : (draft.cwd as NSString).lastPathComponent).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Palette.secondary)
                        }
                        .foregroundStyle(Palette.text)
                        .outlinedPill()
                    }
                    .help(draft.cwd.isEmpty ? "A persistent workspace allocated for this bot" : draft.cwd)
                }
                if !hqProjects.isEmpty || draft.project != nil {
                    ValueRow("Default project", detail: "Chats, threads and tasks start in this hq project and load its context, unless one is picked for them.") {
                        DropdownMenu {
                            var items = [MenuItem("None", selected: draft.project == nil) { draft.project = nil }]
                            items += hqProjects.map { project in
                                MenuItem(project.id, selected: draft.project == project.id) { draft.project = project.id }
                            }
                            return items
                        } label: {
                            HStack(spacing: 6) {
                                Text(draft.project ?? "None").lineLimit(1)
                                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Palette.secondary)
                            }
                            .foregroundStyle(Palette.text)
                            .outlinedPill()
                        }
                    }
                }
                ValueRow("Permissions", detail: draft.permission == "auto"
                         ? "Tool requests are approved automatically. Your agent's own settings (like Claude Code's permission rules) still apply."
                         : "You'll get an approval card and a notification whenever the agent asks.") {
                    ChoicePicker(selection: $draft.permission, options: [("ask", "Ask me"), ("auto", "Approve automatically")])
                }
            }

            CardSection("Activity") {
                SwitchRow("Notifications", detail: "Get notified when this bot finishes or needs you",
                          isOn: Binding(get: { draft.notify ?? true }, set: { draft.notify = $0 }))
                if model.screen != nil, part == .all {
                    SwitchRow("Use the computer", detail: model.screen?.controlReady != true
                        ? "Let this bot use apps. On that computer, open Kith → Settings → Computer access to set up permissions first."
                        : model.screen?.enabled == true
                        ? "Let this bot see the screen and use the mouse and keyboard. You can watch and take over from your phone."
                        : model.screen?.computerUse == true
                        ? "Let this bot see the screen and use the mouse and keyboard."
                        : "Let this bot see the screen and use the mouse and keyboard. On that computer, open Kith → Settings → Computer access to set up permissions first.",
                              isOn: Binding(get: { draft.computer ?? false }, set: { draft.computer = $0 }))
                }
            }

            PluginToggles(
                title: "Connectors",
                empty: "No connectors yet. Add GitHub, Linear, Notion and more from Extensions.",
                items: model.installedConnectors.map { ($0.id, $0.name, $0.command ?? $0.url ?? "") },
                selection: Binding(get: { draft.connectors ?? [] }, set: { draft.connectors = $0 })
            )
            PluginToggles(
                title: "Skills",
                empty: "No skills yet. Get some from Extensions, or write your own.",
                items: model.installedSkills.map { ($0.id, $0.name, $0.description) },
                selection: Binding(get: { draft.skills ?? [] }, set: { draft.skills = $0 }),
                info: { id in viewingSkill = model.installedSkills.first { $0.id == id }.map(SkillRef.init) }
            )
            if let error {
                Text(error).font(.footnote).foregroundStyle(Palette.danger)
            }
        }
    }
}

/// A labeled input inside a section row: label (and an optional note) over the field.
struct Field<Content: View>: View {
    let label: String
    var detail: String?
    @ViewBuilder let content: Content
    @Environment(\.noteLines) private var noteLines

    init(_ label: String, detail: String? = nil, @ViewBuilder content: () -> Content) {
        self.label = label
        self.detail = detail
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).foregroundStyle(Palette.text)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(Palette.secondary).lineSpacing(2)
                        .lineLimit(noteLines)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            content
        }
    }
}

/// An on/off row: title and a short note, the switch on the right.
struct SwitchRow: View {
    let title: String
    var detail: String?
    @Binding var isOn: Bool
    @Environment(\.noteLines) private var noteLines

    init(_ title: String, detail: String? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.detail = detail
        _isOn = isOn
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).foregroundStyle(Palette.text)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(Palette.secondary).lineSpacing(2)
                        .lineLimit(noteLines)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .toggleStyle(.codync)
    }
}

extension View {
    /// A rounded input box: the page color in a filled card, filled in an outlined one.
    func fieldBox(fill: Color? = nil) -> some View {
        modifier(FieldBox(fill: fill))
    }
}

private struct FieldBox: ViewModifier {
    let fill: Color?
    @Environment(\.cardStyle) private var cardStyle

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(fill ?? (cardStyle == .outlined ? Palette.surface : Palette.background),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

extension BotDraft {
    /// A new bot may go without a name: the host names it after its first conversations.
    var isValid: Bool { id == nil || !name.trimmingCharacters(in: .whitespaces).isEmpty }

    /// What the host should get: no stale command unless the agent is custom.
    var normalized: BotDraft {
        var d = self
        if d.backend != "custom" { d.command = nil }
        return d
    }
}

public extension BotStore {
    /// Picks an installed agent we know (a registry agent nobody chose is never the default);
    /// empty cwd requests a personal workspace from the host.
    func fillDefaults(_ draft: inout BotDraft) {
        if hello?.backends.first(where: { $0.id == draft.backend })?.available != true,
           let first = hello?.backends.first(where: { $0.available && $0.curated == true }) {
            draft.backend = first.id
        }
        // Connectors and skills start on; left unset, the host turns on every one.
        if draft.connectors == nil, !installedConnectors.isEmpty {
            draft.connectors = installedConnectors.map(\.id)
        }
        if draft.skills == nil, !installedSkills.isEmpty {
            draft.skills = installedSkills.map(\.id)
        }
    }
}

struct AvatarPicker: View {
    @Binding var draft: BotDraft
    /// What Automatic shows for this bot.
    let automatic: String?
    var isGroup = false

    private var source: String { draft.avatarSource ?? "auto" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            label("Automatic")
            HStack(spacing: 10) {
                if let automatic {
                    portrait(automatic, value: "auto", name: "Automatic")
                }
            }
            .padding(4)
            label("Crew")
            grid(CrewAvatar.names.map { ("crew-\($0)", "crew:\($0)", $0) })
            label("Spares")
            grid(CrewAvatar.spares.map { ("spare-\($0)", "spare:\($0)", $0) })
            if !isGroup {
                label("Color")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        swatch(stored: "", name: "Original") {
                            Circle().strokeBorder(Palette.border, lineWidth: 1.5)
                                .overlay(Image(systemName: "nosign").font(.system(size: 13)).foregroundStyle(Palette.secondary))
                        }
                        ForEach(AvatarPalette.colors) { c in
                            swatch(stored: c.stored, name: c.label) {
                                Circle().fill(LinearGradient(colors: [Color(hex: c.a), Color(hex: c.b)], startPoint: .topLeading, endPoint: .bottomTrailing))
                            }
                        }
                    }
                    .padding(4)
                }
            }
        }
    }

    /// One color choice; `stored` is what goes in `avatarColor` ("" is the untouched body).
    private func swatch<Fill: View>(stored: String, name: String, @ViewBuilder fill: () -> Fill) -> some View {
        let on = stored.isEmpty ? AvatarPalette.pick(draft.avatarColor) == nil : draft.avatarColor == stored
        return fill()
            .frame(width: 26, height: 26)
            .padding(4)
            .background(Circle().strokeBorder(on ? Palette.accent : .clear, lineWidth: 2))
            .contentShape(Circle())
            .onTapGesture { withAnimation(Motion.hover) { draft.avatarColor = stored } }
            .accessibilityLabel(name)
            .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.secondary).padding(.horizontal, 4)
    }

    private func grid(_ items: [(asset: String, value: String, name: String)]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 48), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(items, id: \.value) { portrait($0.asset, value: $0.value, name: $0.name) }
        }
    }

    private func portrait(_ asset: String, value: String, name: String) -> some View {
        CharacterAvatar(portrait: asset, color: draft.avatarColor, size: 36, still: true)
            .padding(4)
            .background(Circle().strokeBorder(source == value ? Palette.accent : .clear, lineWidth: 2))
            .contentShape(Circle())
            .onTapGesture { withAnimation(Motion.hover) { draft.avatarSource = value } }
            .accessibilityLabel(name)
            .accessibilityAddTraits(source == value ? .isSelected : [])
    }
}
