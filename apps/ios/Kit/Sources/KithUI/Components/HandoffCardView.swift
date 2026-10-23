import KithKit
import SwiftUI

/// "Where we left off": only real fields. A field that is empty hides, and a card with none hides itself.
public struct HandoffCardModel: Equatable, Sendable {
    public var done: String?
    public var next: String?
    public var files: [String]
    public var prs: [String]
    /// One carried-over summary with no Done/Next split (a host handoff is a single text); shown without a heading.
    public var note: String?

    public init(done: String? = nil, next: String? = nil, files: [String] = [], prs: [String] = [], note: String? = nil) {
        self.done = done
        self.next = next
        self.files = files
        self.prs = prs
        self.note = note
    }

    private static func clean(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    var doneText: String? { Self.clean(done) }
    var nextText: String? { Self.clean(next) }
    var noteText: String? { Self.clean(note) }
    public var isEmpty: Bool { doneText == nil && nextText == nil && noteText == nil && files.isEmpty && prs.isEmpty }
}

public struct HandoffCardView: View {
    let model: HandoffCardModel

    public init(_ model: HandoffCardModel) { self.model = model }

    public var body: some View {
        if !model.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Label {
                    Text("Where we left off").kithText(.topBar)
                } icon: {
                    Image(systemName: "bookmark").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(Palette.ink)
                if let note = model.noteText { Text(note).kithText(.body).foregroundStyle(Palette.ink) }
                if let done = model.doneText { field("Done", done) }
                if let next = model.nextText { field("Next", next) }
                if !model.files.isEmpty { list("Files", model.files, icon: "doc", mono: true) }
                if !model.prs.isEmpty { list("PRs", model.prs, icon: "arrow.triangle.pull", mono: true) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Palette.panel, in: RoundedRectangle(cornerRadius: KithRadius.card, style: .continuous))
            .accessibilityElement(children: .contain)
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title.uppercased()).kithText(.label).foregroundStyle(Palette.muted)
    }

    private func field(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            heading(title)
            Text(text).kithText(.body).foregroundStyle(Palette.ink)
        }
    }

    private func list(_ title: String, _ items: [String], icon: String, mono: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            heading(title)
            ForEach(items, id: \.self) { item in
                Label {
                    Text(item).kithText(mono ? .code : .body).foregroundStyle(Palette.ink)
                } icon: {
                    Image(systemName: icon).font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
            }
        }
    }
}

#Preview("Handoff, full") {
    HandoffCardView(.init(done: "Fixed the double sleep notice: the wake hook now skips if the sweep sent one.",
                      next: "Open a PR, or batch it with the relay fix.",
                      files: ["kith-sessions.py", "serve/host/sleep.rs"], prs: ["#112 sleep notice"]))
        .padding()
}

#Preview("Handoff, missing fields") {
    VStack {
        HandoffCardView(.init(next: "Run kith doctor next."))
        HandoffCardView(.init(done: "Drafted the widget glyphs.", prs: ["#98"]))
        HandoffCardView(.init())
    }
    .padding()
}
