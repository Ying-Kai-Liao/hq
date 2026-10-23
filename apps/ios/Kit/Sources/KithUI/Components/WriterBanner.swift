import KithKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// What a held thread's banner says, per state. A port of the desktop `writerBannerOf` and `resumeCommand`
/// (apps/desktop/.../kith/logic.ts); the wording must stay identical.
public enum WriterPhase: Equatable, Sendable { case idle, working, taking, failed, unreachable }

public struct WriterBannerModel: Equatable, Sendable {
    public enum Icon: Equatable, Sendable { case terminal, dot, spinner, warning }
    public enum Button: String, Equatable, Sendable { case takeOver = "Take over", tryAgain = "Try again" }

    public let icon: Icon
    public let title: String
    public let sentence: String
    /// The one button, if any.
    public let button: Button?

    /// Take over is for the terminal's owner only (`mine`).
    public static func of(phase: WriterPhase, mac: String, mine: Bool = true, person: String? = nil) -> WriterBannerModel {
        switch phase {
        case .working:
            return .init(icon: .dot, title: "Working in terminal", sentence: "On \(mac). You can take over when it stops.", button: nil)
        case .taking:
            return .init(icon: .spinner, title: "Taking over…", sentence: "Closing the terminal session on \(mac).", button: nil)
        case .failed:
            return .init(icon: .warning, title: "Couldn't take over", sentence: "The terminal on \(mac) still has it.", button: mine ? .tryAgain : nil)
        case .unreachable:
            return .init(icon: .warning, title: "\(mac) unreachable", sentence: "Last seen open in terminal. Reply when it's back.", button: nil)
        case .idle:
            if mine {
                return .init(icon: .terminal, title: "Open in terminal", sentence: "On \(mac). Reply there, or take over.", button: .takeOver)
            }
            let title = person.flatMap { $0.isEmpty ? nil : $0 }.map { "Open in \($0)'s terminal" } ?? "Open in their terminal"
            return .init(icon: .terminal, title: title, sentence: "On \(mac).", button: nil)
        }
    }

    /// The command the take-over sheet shows and Copy puts on the clipboard.
    public static func resumeCommand(agent: String, resumeId: String) -> String { "kith \(agent) --resume \(resumeId)" }
}

/// The banner over a thread a terminal holds. Value inputs only: the screen decides the phase and what the
/// buttons do. `pending` (a take-over request in flight) disables the buttons.
public struct WriterBanner: View {
    let model: WriterBannerModel
    let tint: AgentTint
    let pending: Bool
    let onButton: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    public init(phase: WriterPhase, mac: String, mine: Bool = true, person: String? = nil, tint: AgentTint = .neutral, pending: Bool = false, onButton: @escaping () -> Void = {}) {
        model = .of(phase: phase, mac: mac, mine: mine, person: person)
        self.tint = tint
        self.pending = pending
        self.onButton = onButton
    }

    public var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            HStack(alignment: .top, spacing: 10) {
                icon.frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.title).kithText(.topBar).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.middle)
                    Text(model.sentence).kithText(.secondary).foregroundStyle(Palette.muted).lineLimit(2).truncationMode(.middle)
                }
            }
            if typeSize.isAccessibilitySize == false { Spacer(minLength: 0) }
            if let button = model.button {
                Button(action: onButton) {
                    Text(button.rawValue)
                        .kithText(.secondary).fontWeight(.semibold)
                        .foregroundStyle(Palette.background)
                        .padding(.horizontal, 16)
                        .frame(height: 38)
                        .background(Palette.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(pending)
                .opacity(pending ? 0.5 : 1)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(minHeight: KithSize.chatBoxHeight)
        .kithGlassPill()
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var icon: some View {
        switch model.icon {
        case .terminal: Image(systemName: "terminal").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.muted)
        case .dot: LiveDot(tint: tint)
        case .spinner: ProgressView().controlSize(.small)
        case .warning: Image(systemName: "exclamationmark.triangle").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.negative)
        }
    }
}

/// The take-over confirmation. A sheet, not `kithDialog`, because it shows a mono command with Copy.
public struct TakeOverSheet: View {
    let mac: String
    let command: String
    let pending: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void
    @State private var copied = false

    public init(mac: String, command: String, pending: Bool = false, onConfirm: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.mac = mac
        self.command = command
        self.pending = pending
        self.onConfirm = onConfirm
        self.onCancel = onCancel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Take over from the terminal?").kithText(.topBar).foregroundStyle(Palette.ink)
            Text("This closes the terminal session on \(mac). You can get it back with").kithText(.body).foregroundStyle(Palette.muted)
            HStack(spacing: 8) {
                Text(command).kithText(.code).foregroundStyle(Palette.ink).textSelection(.enabled).lineLimit(2)
                Spacer(minLength: 0)
                Button {
                    #if canImport(UIKit)
                    UIPasteboard.general.string = command
                    #endif
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").kithText(.secondary)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.ink)
            }
            .padding(12)
            .background(Palette.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            HStack(spacing: 10) {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.plain).kithText(.secondary).fontWeight(.semibold).foregroundStyle(Palette.ink)
                    .padding(.horizontal, 16).frame(height: 38)
                    .background(Palette.panel, in: Capsule())
                Spacer(minLength: 0)
                // The screen sets `pending` as soon as it handles the tap, so a second tap cannot send twice.
                Button("Take over", action: onConfirm)
                    .buttonStyle(.plain).kithText(.secondary).fontWeight(.semibold).foregroundStyle(Palette.background)
                    .padding(.horizontal, 16).frame(height: 38)
                    .background(Palette.ink, in: Capsule())
                    .disabled(pending).opacity(pending ? 0.5 : 1)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .presentationDetents([.height(280), .medium])
        .presentationDragIndicator(.visible)
    }
}

#Preview("Writer banner") {
    VStack(spacing: 10) {
        WriterBanner(phase: .idle, mac: "Mac mini")
        WriterBanner(phase: .working, mac: "Mac mini")
        WriterBanner(phase: .taking, mac: "Mac mini", pending: true)
        WriterBanner(phase: .failed, mac: "Mac mini")
        WriterBanner(phase: .unreachable, mac: "Kai's very long MacBook Pro name")
    }
    .padding()
}
