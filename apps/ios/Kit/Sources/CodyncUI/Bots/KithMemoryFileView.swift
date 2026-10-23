import Foundation

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
