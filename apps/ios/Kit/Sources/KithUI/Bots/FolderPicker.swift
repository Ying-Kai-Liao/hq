import KithKit
import SwiftUI

/// Browses folders on the host, drilling down in place. Starts at `start`, else the home folder; the host
/// limits it to home and the drives mounted on the computer.
struct FolderPicker: View {
    let start: String?
    /// The chosen folder and the hq project registered there, if any.
    let onPick: (String, String?) -> Void
    /// Set when the picker is one step of a longer flow: the back button of the first level calls it.
    var onExit: (() -> Void)?
    /// The folders opened so far; the last one is shown.
    @State private var stack: [String?]
    @State private var forward = true
    @State private var showHidden = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(start: String?, onExit: (() -> Void)? = nil, onPick: @escaping (String, String?) -> Void) {
        self.start = start
        self.onPick = onPick
        self.onExit = onExit
        _stack = State(initialValue: [start])
    }

    /// The bot editor's folder: just the path.
    init(start: String?, onPick: @escaping (String) -> Void) {
        self.init(start: start, onExit: nil) { path, _ in onPick(path) }
    }

    var body: some View {
        let current = stack.last ?? nil
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                if stack.count > 1 {
                    BackButton { go(forward: false) { stack.removeLast() } }
                        .padding(.leading, 12)
                        .transition(.opacity)
                } else if let onExit {
                    BackButton(action: onExit).padding(.leading, 12)
                }
                ModalHeader(current.map { ($0 as NSString).lastPathComponent } ?? "Folders")
            }
            ZStack {
                FolderLevel(path: current, showHidden: $showHidden, onPick: onPick, open: { path in
                    go(forward: true) { stack.append(path) }
                }, up: { parent in
                    // Going up from a folder just opened is the same as going back.
                    if stack.count > 1, stack[stack.count - 2] == parent {
                        go(forward: false) { stack.removeLast() }
                    } else {
                        go(forward: false) { stack.append(parent) }
                    }
                }, jump: { root in
                    go(forward: true) { stack = [root] }
                })
                    .id(stack.count)
                    .transition(.asymmetric(
                        insertion: .move(edge: forward ? .trailing : .leading),
                        removal: .move(edge: forward ? .leading : .trailing)
                    ).combined(with: .opacity))
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .clipped()
        }
        .background(Palette.background)
    }

    /// Sets the slide direction first, so the leaving level takes it too, then moves.
    private func go(forward: Bool, _ change: @escaping () -> Void) {
        self.forward = forward
        Task { @MainActor in
            withAnimation(Motion.reduced(Motion.layout, reduceMotion), change)
        }
    }
}

/// One folder's subfolders.
private struct FolderLevel: View {
    let path: String?
    @Binding var showHidden: Bool
    let onPick: (String, String?) -> Void
    let open: (String) -> Void
    let up: (String) -> Void
    let jump: (String) -> Void
    @Environment(BotStore.self) private var model
    @State private var listing: DirListing?
    @State private var error: String?
    @State private var filter = ""

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                SearchField(text: $filter)
                if let listing {
                    if let roots = listing.roots, roots.count > 1 { rootSwitcher(roots, current: listing.path) }
                    CardSection(footer: listing.path) {
                        Button {
                            onPick(listing.path, listing.project)
                        } label: {
                            HStack(spacing: 8) {
                                Label("Use “\((listing.path as NSString).lastPathComponent)”", systemImage: "checkmark.circle.fill")
                                    .font(.headline)
                                    .foregroundStyle(Palette.accent)
                                if let project = listing.project { ProjectBadge(id: project) }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressScale())
                        if let parent = listing.parent {
                            Button { up(parent) } label: {
                                Label("Up to “\((parent as NSString).lastPathComponent)”", systemImage: "arrow.up")
                                    .foregroundStyle(Palette.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(PressScale())
                        }
                        Toggle("Show hidden folders", isOn: $showHidden)
                            .foregroundStyle(Palette.text)
                            .tint(Palette.accent)
                    }
                    let dirs = listing.dirs.filter { filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter) }
                    if !dirs.isEmpty {
                        CardSection {
                            ForEach(dirs) { dir in
                                Button {
                                    open(dir.path)
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: dir.project != nil ? "shippingbox" : dir.isGit ? "arrow.triangle.branch" : "folder")
                                            .foregroundStyle(dir.isGit || dir.project != nil ? Palette.accent : Palette.secondary)
                                            .frame(width: 20)
                                        Text(dir.name).foregroundStyle(Palette.text).lineLimit(1)
                                        if let project = dir.project { ProjectBadge(id: project) }
                                        Spacer(minLength: 8)
                                        Image(systemName: "chevron.right")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(Palette.tertiary)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(PressScale())
                            }
                        }
                    } else if listing.dirs.isEmpty {
                        Text("No folders here.").font(.subheadline).foregroundStyle(Palette.secondary)
                    }
                } else if let error {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(error).foregroundStyle(Palette.danger)
                        Button("Try again") { Task { await load() } }
                            .foregroundStyle(Palette.accent)
                    }
                } else {
                    Spinner(size: 20).frame(maxWidth: .infinity)
                }
            }
            .font(.body)
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .task(id: "\(path ?? "")|\(showHidden)") { await load() }
    }

    /// Home and each drive: jump between them, since "up" stops at a root.
    private func rootSwitcher(_ roots: [DirRoot], current: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(roots) { root in
                    let active = current == root.path || current.hasPrefix(root.path + "/")
                    Button { jump(root.path) } label: {
                        Label(root.name, systemImage: root.path.hasPrefix("/Volumes") ? "externaldrive" : "house")
                            .font(.subheadline)
                            .foregroundStyle(active ? Palette.accent : Palette.text)
                            .outlinedPill()
                    }
                    .buttonStyle(PressScale())
                }
            }
        }
    }

    private func load() async {
        error = nil
        // Not the old folder's rows while the new one loads, nor after it failed.
        listing = nil
        do { listing = try await model.listDirs(path, showHidden: showHidden) } catch { self.error = error.localizedDescription }
    }
}

/// An hq project's id beside the folder registered as it.
struct ProjectBadge: View {
    let id: String

    var body: some View {
        Text(id)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Palette.accent)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Palette.accentDim, in: Capsule())
    }
}
