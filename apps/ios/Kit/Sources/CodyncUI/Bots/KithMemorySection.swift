import CodyncKit
import SwiftUI

/// A memory file to open in the viewer, near a line when it came from a search hit.
struct KithMemoryTarget: Identifiable, Hashable {
    let path: String
    var line: Int?
    var id: String { "\(path):\(line ?? 0)" }
}

/// "Agent memory" on a kith bot's Memory page: search and the files in the agent's own memory folder.
/// Read-only; it is not the bot memory below it.
struct KithMemorySection: View {
    let store: KithInfoStore
    @State private var query = ""
    @State private var result: KithSearchResult?
    @State private var searching = false
    @State private var searchFailed = false
    @State private var target: KithMemoryTarget?

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        if case .unavailable = store.phase {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("Agent memory")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.text)
                    .padding(.leading, 2)
                    .accessibilityAddTraits(.isHeader)
                searchField
                if trimmed.isEmpty { files } else { hits }
            }
            .padding(.bottom, 8)
            // Typing again cancels the request in flight; 300 ms after the last key it asks.
            .task(id: trimmed) { await runSearch(trimmed) }
            .codyncSheet(item: $target) { KithMemoryFileView(store: store, target: $0) }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.secondary)
            TextField("Search this agent's memory", text: $query)
                .textFieldStyle(.plain)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if searching { ProgressView().controlSize(.small) }
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func runSearch(_ text: String) async {
        guard !text.isEmpty else {
            result = nil
            searching = false
            searchFailed = false
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        searching = true
        defer { if !Task.isCancelled { searching = false } }
        do {
            let found = try await store.search(text)
            guard !Task.isCancelled else { return }
            result = found
            searchFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            result = nil
            searchFailed = true
        }
    }

    // MARK: search hits

    @ViewBuilder private var hits: some View {
        if searchFailed {
            note("Search failed")
        } else if let result {
            if let error = result.error, result.hits.isEmpty {
                note("Search unavailable: \(error)")
            } else if result.hits.isEmpty {
                note("No matches")
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(result.hits.enumerated()), id: \.offset) { index, hit in
                        if index > 0 { Divider() }
                        hitRow(hit)
                    }
                }
                .outlinedCard(vertical: 4)
            }
        }
    }

    @ViewBuilder private func hitRow(_ hit: KithSearchHit) -> some View {
        let content = VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(hit.line.map { "\(hit.path):\($0)" } ?? hit.path)
                    .font(.footnote.weight(.medium).monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !hit.openable, let agent = hit.agent {
                    Text(agent).font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Palette.surface, in: Capsule())
                }
            }
            Text(hit.snippet).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        if hit.openable {
            Button { target = KithMemoryTarget(path: hit.path, line: hit.line) } label: { content }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.text)
        } else {
            content.foregroundStyle(Palette.secondary).opacity(0.55).accessibilityHint("Can't be opened here")
        }
    }

    // MARK: files

    @ViewBuilder private var files: some View {
        if let info = store.info {
            if info.errors["memory"] != nil {
                note("Couldn't read the memory files")
            } else if let memory = info.memory, !memory.files.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(memory.ordered.enumerated()), id: \.element.id) { index, file in
                        if index > 0 { Divider() }
                        Button { target = KithMemoryTarget(path: file.path) } label: {
                            HStack(spacing: 8) {
                                Text(file.path).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 8)
                                Text([kithBytes(file.bytes), file.modified.map { kithAgo($0.date) }]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.footnote)
                                    .foregroundStyle(Palette.secondary)
                            }
                            .padding(.vertical, 10)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.text)
                    }
                    Divider()
                    Text("\(memory.files.count) \(memory.files.count == 1 ? "file" : "files") · \(kithBytes(memory.totalBytes))")
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                        .padding(.vertical, 8)
                }
                .outlinedCard(vertical: 0)
            } else {
                note("No memory files yet")
            }
        } else if let failure = store.failure {
            note("Kith details unavailable: \(failure)")
        } else {
            note("Loading…")
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Palette.secondary).padding(.leading, 2)
    }
}
