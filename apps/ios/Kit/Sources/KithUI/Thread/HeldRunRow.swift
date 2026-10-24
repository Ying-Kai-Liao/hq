import KithKit
import SwiftUI

/// The held row inside an answered permission card: an old run still holds the session this approval resumes in.
/// Hairline above, kind icon, two lines, and for the owner a Stop button (a plain capsule: the red is the confirm's).
/// Value inputs only; the card owns the confirm and the call.
struct HeldRunRow: View {
    let model: HeldRunModel
    let onStop: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .center, spacing: 10))
        VStack(alignment: .leading, spacing: 0) {
            Palette.line.frame(height: 1).padding(.top, 4)
            layout {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: model.icon).font(.system(size: 14)).foregroundStyle(Palette.muted).frame(width: 18, height: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.title).kithText(.secondary).fontWeight(.medium).foregroundStyle(Palette.ink)
                        Text(model.sentence).kithText(.secondary)
                            .foregroundStyle(model.isFailed ? Palette.negative : Palette.muted)
                    }
                }
                if !stacked { Spacer(minLength: 0) }
                if model.canStop { stopButton }
            }
            .padding(.top, 10)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(model.accessibilityLabel))
    }

    private var stopping: Bool { model.phase == .stopping }

    private var stopButton: some View {
        Button(action: onStop) {
            ZStack {
                Text(model.buttonTitle).opacity(stopping ? 0 : 1)
                if stopping { Spinner(size: 12) }
            }
            .kithText(.secondary).fontWeight(.semibold).foregroundStyle(Palette.ink)
            .padding(.horizontal, 12)
            .frame(minWidth: 56, minHeight: 32)
            .background(Palette.panel, in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.line, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(stopping)
        .accessibilityLabel(Text("Stop old run"))
        .accessibilityHint(Text(model.buttonHint))
    }
}

/// The transcript line after a Stop: "Stopped the old terminal run · 10:02", with the kind's icon, in the time
/// separator's quiet style.
struct StoppedRunDivider: View {
    let text: String
    let symbol: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
            Text(text).kithText(.secondary)
        }
        .foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .transition(.opacity)
    }
}

#if DEBUG
#Preview("Held run card") {
    let held = HeldRun(session: "s", kind: "terminal", pid: 4812, since: "2026-10-24T09:40:00Z")
    return ScrollView {
        VStack(alignment: .leading, spacing: 18) {
            HeldRunRow(model: HeldRunModel(held: held, mac: "Mac mini", owner: true), onStop: {})
            HeldRunRow(model: HeldRunModel(held: held, mac: "Mac mini", owner: false, ownerName: "Kai"), onStop: {})
            HeldRunRow(model: HeldRunModel(held: held, mac: "Mac mini", owner: true, phase: .stopping), onStop: {})
            HeldRunRow(model: HeldRunModel(held: held, mac: "Mac mini", owner: true, phase: .failed("Try again, or close it on Mac mini.", retry: true)), onStop: {})
            StoppedRunDivider(text: HeldRunModel.stoppedDivider(kind: "terminal", at: .now), symbol: "terminal")
        }.padding()
    }
}
#endif
