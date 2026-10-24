import KithKit
import KithUI
import SwiftUI

/// A Mac that needs you: offline, out of reach, or no longer letting this iPhone in. It sits at the top of
/// Settings and clears itself when the connection changes, so it has no dismiss button. The rule for when
/// it shows is `ComputerProblem`; a version mismatch is the update card's, never this one.
struct MacProblemCard: View {
    let problem: ComputerProblem
    /// Opens the computer's page; nil for a computer joined by invite, which has none.
    let details: (() -> Void)?
    let reconnect: () -> Void
    let pairAgain: () -> Void
    @ScaledMetric(relativeTo: .body) private var buttonHeight: CGFloat = 40

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ink)
                    Text(detail).font(.system(size: 13)).foregroundStyle(Palette.secondary)
                }
                Spacer(minLength: 0)
            }
            // One element to read; the buttons stay their own.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title). \(detail)")

            HStack(spacing: 8) {
                if let details {
                    Button("Details", action: details).buttonStyle(ProblemButtonStyle(primary: false, height: buttonHeight))
                }
                Button(action, action: isAccess ? pairAgain : reconnect).buttonStyle(ProblemButtonStyle(primary: true, height: buttonHeight))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: KithRadius.card, style: .continuous))
    }

    private var isAccess: Bool { if case .unauthorized = problem.kind { true } else { false } }
    private var action: String { isAccess ? "Pair again" : "Reconnect" }

    private var icon: String {
        switch problem.kind {
        case .offline: "desktopcomputer.trianglebadge.exclamationmark"
        case .unreachable: "wifi.slash"
        case .unauthorized: "lock.slash"
        }
    }

    private var title: String {
        switch problem.kind {
        case .offline: "\(problem.name) is offline"
        case .unreachable: "Can't reach \(problem.name)"
        case .unauthorized: "\(problem.name) stopped letting this iPhone in"
        }
    }

    private var detail: String {
        switch problem.kind {
        case let .offline(lastSeen):
            let back = "Its agents pick up again when it's back."
            return lastSeen.map { "Last seen \(RelativeTime.day($0)). \(back)" } ?? back
        case .unreachable:
            return "This iPhone can't connect to it right now."
        case let .unauthorized(message):
            return message.isEmpty ? "Access was removed on the Mac." : message
        }
    }
}

/// 40-tall, radius 12: the card's Details (the page's ground on the panel) and its main action (ink).
private struct ProblemButtonStyle: ButtonStyle {
    let primary: Bool
    let height: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(primary ? Palette.background : Palette.ink)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(primary ? Palette.ink : Palette.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
