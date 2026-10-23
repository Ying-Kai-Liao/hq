import KithKit
import SwiftUI

/// A line in the transcript where the writer changed (continue-anywhere spec). Looks like the time separator,
/// a hairline either side of a quiet word. `time` is already formatted by the screen ("9:40").
public struct WriterDivider: View {
    public enum Kind: Equatable, Sendable {
        case startedInTerminal(mac: String)
        case openedInTerminal(mac: String)
        case tookOver
        case terminalClosed

        func text(time: String) -> String {
            switch self {
            case .startedInTerminal(let mac): "Started in the terminal on \(mac) · \(time)"
            case .openedInTerminal(let mac): "Opened in terminal on \(mac) · \(time)"
            case .tookOver: "You took over from the terminal · \(time)"
            case .terminalClosed: "Terminal closed · \(time)"
            }
        }
    }

    let kind: Kind
    let time: String
    public init(_ kind: Kind, time: String) { self.kind = kind; self.time = time }

    public static func text(_ kind: Kind, time: String) -> String { kind.text(time: time) }

    public var body: some View {
        HStack(spacing: 10) {
            rule
            Text(kind.text(time: time))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Palette.muted)
                .lineLimit(2).multilineTextAlignment(.center)
            rule
        }
        .padding(.horizontal, 16)
        .padding(.top, 18).padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }

    private var rule: some View { Palette.line.frame(height: 1).frame(maxWidth: .infinity) }
}

#Preview("Writer dividers") {
    VStack {
        WriterDivider(.startedInTerminal(mac: "Mac mini"), time: "9:40")
        WriterDivider(.openedInTerminal(mac: "Mac mini"), time: "10:31")
        WriterDivider(.tookOver, time: "10:02")
        WriterDivider(.terminalClosed, time: "10:48")
    }
}
