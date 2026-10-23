import KithKit
import SwiftUI

/// Where a thread started, when it was not the app (continue-anywhere spec): a quiet word and symbol, never a
/// terminal view. It never truncates.
public struct OriginTag: View {
    public enum Origin: String, CaseIterable, Equatable, Sendable {
        case terminal, discord, telegram, slack

        public var word: String {
            switch self {
            case .terminal: "Terminal"
            case .discord: "Discord"
            case .telegram: "Telegram"
            case .slack: "Slack"
            }
        }

        var symbol: String { self == .terminal ? "terminal" : "bubble.left.and.bubble.right" }
    }

    let origin: Origin
    public init(_ origin: Origin) { self.origin = origin }

    public var body: some View {
        HStack(spacing: 4) {
            Image(systemName: origin.symbol).font(.system(size: 10, weight: .medium))
            Text(origin.word).kithText(.label).lineLimit(1).fixedSize()
        }
        .foregroundStyle(Palette.muted)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Started in \(origin.word)"))
    }
}

/// The live dot of a thread a terminal is writing to: the agent's colour pair with a soft halo that pulses.
/// Static under Reduce Motion and while the app is not active.
public struct LiveDot: View {
    let tint: AgentTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var dim = false

    public init(tint: AgentTint = .neutral) { self.tint = tint }

    private var pulses: Bool { !reduceMotion && scenePhase == .active }

    public var body: some View {
        Circle()
            .fill(LinearGradient(colors: [tint.a, tint.b], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 6, height: 6)
            .padding(2)
            .background(tint.b.opacity(0.3), in: Circle())
            .opacity(pulses && dim ? 0.4 : 1)
            .animation(pulses ? .easeInOut(duration: 1.4).repeatForever(autoreverses: true) : nil, value: dim)
            .onAppear { dim = true }
            .accessibilityHidden(true)
    }
}

#Preview("Origin tags") {
    VStack(alignment: .leading, spacing: 10) {
        ForEach(OriginTag.Origin.allCases, id: \.self) { OriginTag($0) }
        LiveDot(tint: AgentTint.resolve("kith:sky"))
    }
    .padding()
}
