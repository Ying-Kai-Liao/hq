import KithKit
import SwiftUI

/// A row of the agent sheet: muted icon, title (13.5/500), subtitle (11.5 muted), a muted value and a chevron
/// (app-style/agent-sheet.png). The group around it is a `CardSection`.
struct SheetRow<Trailing: View>: View {
    var icon: String?
    let title: String
    var detail: String?
    var chevron = false
    /// A chevron that turns when the row is open; nil keeps it pointing right.
    var open: Bool?
    var accent = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 11) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    .foregroundStyle(accent ? Palette.accent : Palette.muted)
                    .frame(width: 18)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(accent ? Palette.accent : Palette.ink)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 11.5))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing
                .font(.system(size: 13))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
            if chevron || open != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.muted.opacity(0.7))
                    .rotationEffect(.degrees(open == true ? 90 : 0))
            }
        }
        .frame(minHeight: 28)
        .contentShape(Rectangle())
    }
}

extension SheetRow where Trailing == EmptyView {
    init(icon: String? = nil, title: String, detail: String? = nil, chevron: Bool = false, accent: Bool = false) {
        self.init(icon: icon, title: title, detail: detail, chevron: chevron, accent: accent) { EmptyView() }
    }
}

extension SheetRow where Trailing == Text {
    init(icon: String? = nil, title: String, detail: String? = nil, value: String, chevron: Bool = false) {
        self.init(icon: icon, title: title, detail: detail, chevron: chevron) { Text(value) }
    }
}

/// A row that opens and closes in place: title, count, chevron.
struct SheetCountRow<Content: View>: View {
    let icon: String
    let title: String
    let count: Int
    @ViewBuilder var content: Content
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { open.toggle() }
            } label: {
                SheetRow(icon: icon, title: title, open: open) { Text("\(count)").monospacedDigit() }
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { VStack(alignment: .leading, spacing: 12) { content }.padding(.leading, 29) }
        }
    }
}

/// A quiet line for a part that couldn't be read, with an optional Retry.
struct SheetNote: View {
    let text: String
    var danger = false
    var retry: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Text(text)
                .font(.system(size: 11.5))
                .foregroundStyle(danger ? Palette.danger : Palette.muted)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            if let retry {
                Button("Retry", action: retry)
                    .buttonStyle(.plain)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(Palette.accent)
            }
        }
    }
}
