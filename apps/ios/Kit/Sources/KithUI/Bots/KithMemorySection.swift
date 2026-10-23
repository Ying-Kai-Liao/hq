import KithKit
import SwiftUI

/// Search over a kith agent's memory. Used as "This agent"'s search: a hit opens through `openHit`.
struct KithMemorySection: View {
    let store: KithInfoStore
    /// Opens a hit's file (`path` relative to the memory folder) near `line`.
    let openHit: (String, Int?) -> Void
    @State private var query = ""
    @State private var result: KithSearchResult?
    @State private var searching = false
    @State private var searchFailed = false

    /// Nothing to show once the load is over: an older host, or a bot kith doesn't know.
    private var hidden: Bool {
        switch store.phase {
        case .unavailable: true
        case .loaded(let response): response.info == nil && response.error == nil
        case .loading: false
        }
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        if hidden {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                searchField
                if !trimmed.isEmpty { hits }
            }
            // Typing again cancels the request in flight; 300 ms after the last key it asks.
            .task(id: trimmed) { await runSearch(trimmed) }
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
        // The old answer is for another query.
        result = nil
        searchFailed = false
        searching = true
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
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
        } else if result == nil && searching {
            note("Searching…")
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
        if hit.openable && hit.path.lowercased().hasSuffix(".md") {
            Button { openHit(hit.path, hit.line) } label: { content }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.text)
        } else {
            content.foregroundStyle(Palette.secondary).opacity(0.55).accessibilityHint("Can't be opened here")
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Palette.secondary).padding(.leading, 2)
    }
}
