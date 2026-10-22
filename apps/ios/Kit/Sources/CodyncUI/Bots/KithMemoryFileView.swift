import CodyncKit
import SwiftUI

/// A file split where a reader can jump to a line: at blank lines outside code fences, and every 60 lines at most.
enum KithMemoryChunks {
    struct Chunk: Equatable {
        /// The 1-based line the chunk starts on.
        var line: Int
        var text: String
    }

    /// Formatted mode never cuts inside a code fence. Raw mode (`raw`) may cut anywhere, and also chops a very long
    /// line (a file with no newlines) into pieces so the lazy list has something small to lay out.
    static func split(_ text: String, raw: Bool = false) -> [Chunk] {
        var chunks: [Chunk] = []
        var current: [Substring] = []
        var start = 1
        var fenced = false
        for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if current.isEmpty { start = index + 1 }
            current.append(line)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { fenced.toggle() }
            if (trimmed.isEmpty && !fenced) || (current.count >= maxLines && (raw || !fenced)) {
                chunks.append(Chunk(line: start, text: current.joined(separator: "\n")))
                current = []
            }
        }
        if !current.isEmpty { chunks.append(Chunk(line: start, text: current.joined(separator: "\n"))) }
        guard raw else { return chunks }
        return chunks.flatMap { chunk -> [Chunk] in
            guard chunk.text.count > pieceSize else { return [chunk] }
            var pieces: [Chunk] = []
            var rest = Substring(chunk.text)
            while !rest.isEmpty {
                pieces.append(Chunk(line: chunk.line, text: String(rest.prefix(pieceSize))))
                rest = rest.dropFirst(pieceSize)
            }
            return pieces
        }
    }

    /// The chunk a line falls in.
    static let pieceSize = 4000
    /// Short enough that a search hit lands close to its line.
    static let maxLines = 60

    static func index(of line: Int, in chunks: [Chunk]) -> Int? {
        chunks.lastIndex { $0.line <= line }
    }
}

/// Reads one file of the agent's memory: markdown, or the raw text. No editing.
struct KithMemoryFileView: View {
    let store: KithInfoStore
    let target: KithMemoryTarget
    @State private var file: KithMemoryFile?
    @State private var formattedChunks: [KithMemoryChunks.Chunk] = []
    @State private var rawChunks: [KithMemoryChunks.Chunk] = []
    @State private var error: String?
    @State private var raw = false

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader(target.path) {
                Button(raw ? "Formatted" : "Raw") { raw.toggle() }
                    .buttonStyle(.plain)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.accent)
                    .disabled(file == nil)
            }
            if let error {
                Text(error).foregroundStyle(Palette.danger).padding(20).frame(maxWidth: .infinity, alignment: .leading)
            } else if let file {
                reader(file)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
            }
            Spacer(minLength: 0)
        }
        .background(Palette.background)
        .task(id: target.id) { await load() }
    }

    private var chunks: [KithMemoryChunks.Chunk] { raw ? rawChunks : formattedChunks }

    private func reader(_ file: KithMemoryFile) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: raw ? 0 : 8) {
                    if file.truncated {
                        Text("Showing the first 512 KB of \(kithBytes(file.bytes))")
                            .font(.footnote)
                            .foregroundStyle(Palette.secondary)
                            .padding(.bottom, 4)
                    }
                    ForEach(Array(chunks.enumerated()), id: \.offset) { index, chunk in
                        Group {
                            if raw {
                                Text(chunk.text).font(.footnote.monospaced()).foregroundStyle(Palette.text)
                            } else {
                                MarkdownText(chunk.text)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(highlighted(index) ? Palette.accentDim : .clear)
                        .id(index)
                    }
                    if chunks.isEmpty { Text("This file is empty").foregroundStyle(Palette.secondary) }
                }
                .textSelection(.enabled)
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .onChange(of: raw) { _, _ in scroll(proxy) }
            .task(id: file.path) {
                // Lazy rows need a moment before they can be scrolled to.
                try? await Task.sleep(for: .milliseconds(100))
                scroll(proxy)
            }
        }
    }

    private func highlighted(_ index: Int) -> Bool {
        guard let line = target.line else { return false }
        return KithMemoryChunks.index(of: line, in: chunks) == index
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        guard let line = target.line, let index = KithMemoryChunks.index(of: line, in: chunks) else { return }
        proxy.scrollTo(index, anchor: .top)
    }

    private func load() async {
        do {
            let loaded = try await store.file(target.path)
            guard !Task.isCancelled else { return }
            formattedChunks = KithMemoryChunks.split(loaded.text)
            rawChunks = KithMemoryChunks.split(loaded.text, raw: true)
            file = loaded
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}
