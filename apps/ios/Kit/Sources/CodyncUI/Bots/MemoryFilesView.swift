import CodyncKit
import SwiftUI

/// One layer's long-form notes, under its entries: name, description, size and date, marked past a cap.
struct MemoryFilesList: View {
    let memory: MemoryStore
    let files: MemoryFiles
    let shared: Bool
    @State private var open: MemoryFileTarget?

    var body: some View {
        let folder = shared ? files.yours : files.bot
        let live = folder.files.filter { !$0.deleted }
        let gone = folder.files.filter(\.deleted)
        HStack(spacing: 8) {
            Text("Notes").font(.footnote.weight(.semibold)).foregroundStyle(Palette.secondary)
            Spacer(minLength: 0)
            IconButton("New note", systemImage: "doc.badge.plus") {
                withAnimation(Motion.layout) { open = MemoryFileTarget(name: nil, shared: shared) }
            }
            .disabled(memory.busy)
        }
        .padding(.top, 6)
        .codyncSheet(item: $open) { target in MemoryFileView(memory: memory, target: target) }
        if live.isEmpty {
            Text("Longer notes, one topic each. The bot reads one when its topic comes up.")
                .font(.footnote).foregroundStyle(Palette.tertiary)
        } else if live.count > files.folderCap {
            Text("\(live.count) notes, over the \(files.folderCap)-note cap. Merge some.")
                .font(.footnote).foregroundStyle(Palette.attention)
        }
        ForEach(live) { file in row(file, cap: files.cap) }
        ForEach(gone) { file in row(file, cap: files.cap) }
    }

    private func row(_ file: MemoryFile, cap: Int) -> some View {
        Button {
            withAnimation(Motion.layout) { open = MemoryFileTarget(name: file.name, shared: shared) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Label(file.name, systemImage: file.deleted ? "doc" : "doc.text")
                    .foregroundStyle(file.deleted ? Palette.tertiary : Palette.text)
                if let description = file.description, !file.deleted {
                    Text(description).font(.footnote).foregroundStyle(Palette.secondary)
                }
                Text(caption(file, cap: cap))
                    .font(.caption)
                    .foregroundStyle(file.tokens > cap && !file.deleted ? Palette.attention : Palette.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 6)
    }

    private func caption(_ file: MemoryFile, cap: Int) -> String {
        let when = Date(milliseconds: file.updatedAt).formatted(.relative(presentation: .named))
        if file.deleted { return "Deleted \(when)" }
        return "\(file.tokens) tokens\(file.tokens > cap ? ", over the \(cap) cap" : "") · \(when)"
    }
}

/// What a note sheet opens: a file, or (`name` nil) a new one.
struct MemoryFileTarget: Identifiable {
    let id = UUID()
    let name: String?
    let shared: Bool
}

/// One note: read it, edit it, delete it, or bring back an earlier version.
struct MemoryFileView: View {
    let memory: MemoryStore
    let target: MemoryFileTarget
    @State private var detail: MemoryFileDetail?
    /// The text being edited; nil while reading.
    @State private var draft: String?
    @State private var name = ""
    @State private var confirmDelete = false
    @Environment(BotStore.self) private var host
    @Environment(\.dismissModal) private var dismiss

    private static let template = "---\ndescription: When to read this note\n---\n"

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader(target.name ?? "New note") { actions }
            CardForm {
                if let error = memory.error {
                    CardSection { Text(error).foregroundStyle(Palette.danger).textSelection(.enabled) }
                }
                if let text = Binding($draft) {
                    editor(text)
                } else if let detail {
                    reader(detail)
                } else {
                    CardSection { Text("Loading…").foregroundStyle(Palette.secondary) }
                }
            }
        }
        .background(Palette.background)
        .task {
            if let file = target.name {
                detail = await memory.file(file, shared: target.shared)
            } else {
                draft = Self.template
            }
        }
        .codyncDialog("Delete \(target.name ?? "this note")?", isPresented: $confirmDelete,
                      message: "Its versions stay, so you can bring it back.") {
            [DialogAction("Delete", destructive: true) {
                Task { await change(content: nil) }
            }]
        }
    }

    @ViewBuilder private var actions: some View {
        if memory.busy {
            Spinner()
        } else if let draft {
            IconButton("Save", systemImage: "checkmark") { Task { await change(content: draft) } }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (target.name == nil && !validName))
        } else if let detail, let content = detail.content {
            HStack(spacing: 2) {
                IconButton("Edit", systemImage: "pencil") { withAnimation(Motion.layout) { self.draft = content } }
                IconButton("Delete", systemImage: "trash") { withAnimation(Motion.layout) { confirmDelete = true } }
            }
        }
    }

    private var validName: Bool { name.range(of: #"^[a-z0-9-]+\.md$"#, options: .regularExpression) != nil }

    @ViewBuilder private func editor(_ text: Binding<String>) -> some View {
        if target.name == nil {
            CardSection(footer: "Lowercase letters, digits and dashes, ending in .md.") {
                TextField("people.md", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        }
        CardSection(footer: "The description: line says when the bot should read it.") {
            TextField("", text: text, axis: .vertical)
                .lineLimit(12...40)
                .font(.footnote.monospaced())
        }
        .textFieldStyle(.plain)
    }

    @ViewBuilder private func reader(_ detail: MemoryFileDetail) -> some View {
        CardSection(footer: detail.path) {
            if let content = detail.content {
                Text(content).font(.footnote.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("Deleted. Bring back a version below.").foregroundStyle(Palette.secondary)
            }
        }
        CardSection("Versions") {
            ForEach(detail.versions) { version in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(who(version))
                        Text(Date(milliseconds: version.at).formatted(.relative(presentation: .named)))
                            .font(.caption).foregroundStyle(Palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let content = version.content, content != detail.content {
                        IconButton("Bring back this version", systemImage: "arrow.uturn.backward") {
                            Task { await change(version: version.id) }
                        }
                        .disabled(memory.busy)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func who(_ version: MemoryFileVersion) -> String {
        let by = switch version.author {
        case "user": "You"
        case "bot": host.bots[version.authorBot ?? ""]?.name ?? "A bot"
        case "dream": "Dreaming"
        default: "This computer"
        }
        return switch version.cause {
        case "delete": "\(by) deleted it"
        case "restore": "\(by) brought back a version"
        case "undo": "\(by) undid a change"
        default: "\(by) changed it"
        }
    }

    /// Saves (`content`), deletes (nil) or restores `version`, over what was loaded.
    private func change(content: String? = nil, version: Int64? = nil) async {
        let file = target.name ?? name
        let base = target.name == nil ? nil : detail?.hash
        if await memory.changeFile(file, shared: target.shared, base: base, content: content, version: version) {
            if content == nil && version == nil { dismiss(); return }
            withAnimation(Motion.layout) { draft = nil }
            if target.name == nil { dismiss(); return }
            detail = await memory.file(file, shared: target.shared)
        }
    }
}
