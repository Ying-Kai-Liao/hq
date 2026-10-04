import CodyncKit
import SwiftUI

/// The iPhone's Markdown renderer for messages (`MarkdownBlocks`: tables, rules, nested lists
/// too); inline styling comes from `AttributedString(markdown:)`.
/// Equatable so a reply that didn't change skips its body; each block is equatable too, so
/// while text streams only the block being written renders again.
public struct MarkdownText: View, Equatable {
    let source: String
    /// Text is still arriving: the open end hides half-written syntax.
    let streaming: Bool
    /// New text is surfacing right now: the open end fades in.
    let revealing: Bool

    public init(_ source: String, streaming: Bool = false, revealing: Bool = false) {
        self.source = source
        self.streaming = streaming
        self.revealing = revealing
    }

    public var body: some View {
        let blocks = MarkdownBlocks.parse(source, streaming: streaming)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                MarkdownBlock(block: block, writing: revealing && i == blocks.count - 1).equatable()
            }
        }
        .textSelection(.enabled)
    }

    /// Inline styling; inline code gets a soft tint behind it.
    static func inline(_ s: String) -> AttributedString {
        guard var text = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else { return AttributedString(s) }
        for run in text.runs where run.inlinePresentationIntent?.contains(.code) == true {
            text[run.range].backgroundColor = Palette.text.opacity(0.08)
        }
        return text
    }
}

/// One block of a reply. The block being written (`writing`) fades in toward its end, so
/// new words surface instead of popping in; once it's done the fade settles.
private struct MarkdownBlock: View, @MainActor Equatable {
    let block: MarkdownBlocks.Block
    let writing: Bool
    @Environment(\.conversationTypography) private var typography
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    nonisolated static func == (a: Self, b: Self) -> Bool { a.block == b.block && a.writing == b.writing }

    var body: some View {
        // The fade alone eases out; text and layout changes stay unanimated.
        content.animation(Motion.reduced(.easeOut(duration: 0.35), reduceMotion)) {
            $0.writingFade(writing && !reduceMotion && block.isText)
        }
    }

    @ViewBuilder private var content: some View {
        switch block {
        case let .paragraph(t):
            Text(MarkdownText.inline(t))
                .font(typography.body)
                .foregroundStyle(Palette.text)
        case let .heading(t, level):
            Text(MarkdownText.inline(t))
                .font(typography.heading(level: level))
                .foregroundStyle(Palette.text)
        case let .bullet(t, marker, depth):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker).foregroundStyle(Palette.secondary).monospacedDigit()
                Text(MarkdownText.inline(t)).foregroundStyle(Palette.text)
            }
            .font(typography.body)
            .padding(.leading, CGFloat(depth) * 16)
        case .rule:
            Rectangle().fill(Palette.border).frame(height: 1).padding(.vertical, 4)
        case let .table(header, rows):
            MarkdownTable(header: header, rows: rows)
        case let .quote(t):
            Text(MarkdownText.inline(t))
                .font(typography.body)
                .foregroundStyle(Palette.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Palette.border).frame(width: 3) }
        case let .code(t, _):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(t)
                    .font(typography.code)
                    .foregroundStyle(Palette.text)
                    .padding(10)
            }
            .background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// A Markdown table: a bold header and hairlines between rows, scrolling sideways when wide.
private struct MarkdownTable: View {
    let header: [String]
    let rows: [[String]]
    @Environment(\.conversationTypography) private var typography

    var body: some View {
        let columns = max(header.count, rows.map(\.count).max() ?? 0)
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                GridRow {
                    ForEach(0 ..< columns, id: \.self) { i in
                        Text(MarkdownText.inline(i < header.count ? header[i] : "")).fontWeight(.semibold)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Rectangle().fill(Palette.border).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(0 ..< columns, id: \.self) { i in
                            Text(MarkdownText.inline(i < row.count ? row[i] : ""))
                        }
                    }
                }
            }
            .font(typography.body)
            .foregroundStyle(Palette.text)
            .fixedSize()
            .padding(.vertical, 2)
        }
    }
}

private extension View {
    @ViewBuilder func writingFade(_ on: Bool) -> some View {
        if #available(iOS 18, *) {
            textRenderer(TrailingFade(length: on ? TrailingFade.writingLength : 0))
        } else {
            self
        }
    }
}

/// Draws text with its last `length` glyphs fading out toward the end, the soft edge of text
/// being written. As more arrives, earlier glyphs move out of the fade and settle.
@available(iOS 18, *)
private struct TrailingFade: TextRenderer {
    static let writingLength: Double = 28
    var length: Double

    var animatableData: Double {
        get { length }
        set { length = newValue }
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        guard length > 0.5 else {
            for line in layout { context.draw(line) }
            return
        }
        let total = layout.reduce(0) { $0 + $1.reduce(0) { $0 + $1.count } }
        var index = 0
        for line in layout {
            for run in line {
                // Whole runs before the fade draw as they are.
                if Double(total - index - run.count) >= length {
                    context.draw(run)
                    index += run.count
                    continue
                }
                for slice in run {
                    let fromEnd = Double(total - index)
                    index += 1
                    var glyph = context
                    if fromEnd <= length { glyph.opacity = (fromEnd / (length + 1)) * 0.9 + 0.1 }
                    glyph.draw(slice)
                }
            }
        }
    }
}
