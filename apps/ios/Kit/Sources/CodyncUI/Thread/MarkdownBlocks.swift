import Foundation

/// Block-level Markdown as replies use it: paragraphs, headings, nested lists, quotes, rules,
/// tables and fenced code. Pure parsing, apart from the views, so it's tested on its own.
/// The iPhone's `MarkdownText` renders these; the Mac's has its own smaller parser.
enum MarkdownBlocks {
    enum Block: Hashable {
        case paragraph(String)
        case heading(String, level: Int)
        case bullet(String, marker: String, depth: Int = 0)
        case quote(String)
        case code(String, language: String)
        case table(header: [String], rows: [[String]])
        case rule

        /// Flowing text (where a fading end reads as words arriving).
        var isText: Bool {
            switch self {
            case .paragraph, .heading, .bullet, .quote: true
            case .code, .table, .rule: false
            }
        }
    }

    /// Blocks of `source`; while `streaming`, the last one is healed so a marker that's only
    /// half there (`**bo`, `` `co ``, `[link](ht`) doesn't flash as raw syntax.
    static func parse(_ source: String, streaming: Bool) -> [Block] {
        var blocks = parse(source)
        guard streaming, let last = blocks.last else { return blocks }
        switch last {
        case let .paragraph(t): blocks[blocks.count - 1] = .paragraph(heal(t))
        case let .heading(t, level): blocks[blocks.count - 1] = .heading(heal(t), level: level)
        case let .bullet(t, marker, depth): blocks[blocks.count - 1] = .bullet(heal(t), marker: marker, depth: depth)
        case let .quote(t): blocks[blocks.count - 1] = .quote(heal(t))
        case .code, .table, .rule: break
        }
        return blocks
    }

    /// Closes the inline markers left open at the end of text being written.
    static func heal(_ text: String) -> String {
        var t = text
        // A link still being typed shows as its label: `[label](partial` or `[label`.
        if let open = t.lastIndex(of: "[") {
            let rest = t[t.index(after: open)...]
            if let close = rest.firstIndex(of: "]") {
                let after = rest[rest.index(after: close)...]
                if after.hasPrefix("("), !after.contains(")") { t = String(t[..<open]) + rest[..<close] }
            } else if !rest.contains("\n"), rest.count < 120 {
                t = String(t[..<open]) + rest
            }
        }
        let ticks = t.count(where: { $0 == "`" })
        if ticks % 2 == 1 { t += "`" }
        // Outside inline code only.
        let plain = t.split(separator: "`", omittingEmptySubsequences: false).enumerated()
            .filter { $0.offset % 2 == 0 }.map(\.element).joined()
        for marker in ["**", "~~"] where plain.components(separatedBy: marker).count % 2 == 0 {
            t += marker
        }
        return t
    }

    static func parse(_ source: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var table: [String] = []
        var code: [String]?
        var language = ""

        func flush() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
            if !table.isEmpty {
                // A header and its `|---|` line make a table; anything less stays text.
                if table.count >= 2, isTableRule(table[1]) {
                    blocks.append(.table(header: cells(table[0]), rows: table.dropFirst(2).map(cells)))
                } else {
                    blocks.append(.paragraph(table.joined(separator: "\n")))
                }
                table = []
            }
        }

        for raw in source.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let c = code {
                    blocks.append(.code(c.joined(separator: "\n"), language: language))
                    code = nil
                } else {
                    flush()
                    code = []
                    language = String(line.dropFirst(3))
                }
                continue
            }
            if code != nil {
                code?.append(raw)
                continue
            }
            if line.hasPrefix("|") {
                if !paragraph.isEmpty { flush() }
                table.append(line)
                continue
            }
            if !table.isEmpty { flush() }
            let depth = min(raw.prefix { $0 == " " || $0 == "\t" }.count / 2, 3)
            if line.isEmpty {
                flush()
            } else if line == "---" || line == "***" || line == "___" {
                flush()
                blocks.append(.rule)
            } else if let hashes = line.firstIndex(where: { $0 != "#" }), line.hasPrefix("#"), line[hashes] == " " {
                flush()
                let level = line.distance(from: line.startIndex, to: hashes)
                blocks.append(.heading(String(line[hashes...]).trimmingCharacters(in: .whitespaces), level: level))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") || line.hasPrefix("• ") {
                flush()
                blocks.append(.bullet(String(line.dropFirst(2)), marker: depth > 0 ? "◦" : "•", depth: depth))
            } else if let dot = line.firstIndex(of: "."), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty,
                      line[line.index(after: dot)...].hasPrefix(" ") {
                flush()
                blocks.append(.bullet(String(line[line.index(dot, offsetBy: 2)...]), marker: String(line[...dot]), depth: depth))
            } else if line.hasPrefix(">") {
                flush()
                blocks.append(.quote(String(line.dropFirst()).trimmingCharacters(in: .whitespaces)))
            } else {
                paragraph.append(raw)
            }
        }
        if let c = code { blocks.append(.code(c.joined(separator: "\n"), language: language)) }
        flush()
        return blocks
    }

    private static func isTableRule(_ line: String) -> Bool {
        line.contains("-") && line.allSatisfy { "|-: ".contains($0) }
    }

    private static func cells(_ line: String) -> [String] {
        var row = line
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|") { row.removeLast() }
        return row.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
