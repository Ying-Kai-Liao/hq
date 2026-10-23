import KithKit
import SwiftUI

/// The ink count badge on rows (18 pt) and on the Board tab (16 pt): white Inter 11 bold, tabular figures.
/// Zero or less shows nothing.
public struct CountBadge: View {
    let count: Int
    let size: CGFloat

    public init(_ count: Int, size: CGFloat = KithSize.countBadge) {
        self.count = count
        self.size = size
    }

    /// "3", "99+", nil for nothing waiting.
    public static func text(for count: Int) -> String? {
        count <= 0 ? nil : count > 99 ? "99+" : String(count)
    }

    public var body: some View {
        if let text = Self.text(for: count) {
            Text(text)
                .font(KithText.label.font)
                .monospacedDigit()
                .foregroundStyle(Palette.background)
                .lineLimit(1)
                // The badge keeps its size; a huge Dynamic Type setting must not stretch a row.
                .dynamicTypeSize(...DynamicTypeSize.large)
                .padding(.horizontal, 5)
                .frame(minWidth: size, minHeight: size)
                .background(Palette.ink, in: Capsule())
                .accessibilityLabel(Text("\(count) waiting"))
        }
    }
}

/// A state, by word and by colour: the colour never carries it alone.
public struct StatusChip: View {
    public enum Kind: Equatable, Sendable {
        case live, catchingUp, needsYou, macUnreachable, urgent
        /// A machine-trouble line, already worded: "Mac mini busy, 1 queued".
        case machineTrouble(String)

        public static func busy(computer: String, queued: Int) -> Kind {
            .machineTrouble(queued > 0 ? "\(computer) busy, \(queued) queued" : "\(computer) busy")
        }

        public var word: String {
            switch self {
            case .live: "Live"
            case .catchingUp: "Catching up"
            case .needsYou: "Needs you"
            case .macUnreachable: "Mac unreachable"
            case .urgent: "/urgent"
            case .machineTrouble(let text): text
            }
        }

        var colour: Color {
            switch self {
            case .live: Palette.positive
            case .catchingUp, .machineTrouble: Palette.muted
            case .needsYou: Palette.ink
            case .macUnreachable, .urgent: Palette.negative
            }
        }

        var symbol: String? {
            switch self {
            case .live, .needsYou: nil
            case .catchingUp: "arrow.triangle.2.circlepath"
            case .macUnreachable: "wifi.slash"
            case .urgent: "exclamationmark"
            case .machineTrouble: "hourglass"
            }
        }
    }

    let kind: Kind
    public init(_ kind: Kind) { self.kind = kind }

    public var body: some View {
        HStack(spacing: 5) {
            if let symbol = kind.symbol {
                Image(systemName: symbol).font(.system(size: 10, weight: .bold))
            } else {
                Circle().frame(width: 6, height: 6)
            }
            Text(kind.word).kithText(kind == .urgent ? .code : .secondary).fontWeight(.medium).lineLimit(1).fixedSize()
        }
        .foregroundStyle(kind.colour)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(kind.colour.opacity(0.12), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(kind.word))
    }
}

#Preview("Chips and badges") {
    VStack(alignment: .leading, spacing: 10) {
        HStack { StatusChip(.live); StatusChip(.catchingUp); StatusChip(.needsYou) }
        HStack { StatusChip(.macUnreachable); StatusChip(.urgent) }
        StatusChip(.busy(computer: "Mac mini", queued: 1))
        HStack { CountBadge(1); CountBadge(12); CountBadge(100); CountBadge(3, size: KithSize.countBadgeBoard); CountBadge(0) }
    }
    .padding()
}
