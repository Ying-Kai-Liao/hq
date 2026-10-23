import ActivityKit
import KithKit
import KithUI
import SwiftUI

struct ActivityGalleryView: View {
    /// The presentations shown: the State tab splits Lock Screen from the Dynamic Island.
    var forms = BotActivityPreview.Form.allCases
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @AppStorage("liveActivitiesEnabled") private var enabled = true
    @State private var allowed = ActivityAuthorizationInfo().areActivitiesEnabled
    @State private var form: BotActivityPreview.Form?
    @State private var phase = BotActivityPresentation.Phase.working
    @State private var startedAt = Date.now - 154

    private var island: Bool { !forms.contains(.lockScreen) }

    private var state: BotActivityPresentation {
        let status: String = switch phase {
        case .sending: "sending"
        case .queued: "queued"
        case .working, .stale: "working"
        case .needsInput: "needsInput"
        case .completed: "idle"
        case .failed: "error"
        case .waiting: "unknown"
        }
        return .init(status: status, activity: phase == .needsInput ? "Review the proposed changes." : "Running the test suite.",
                     isStale: phase == .stale)
    }

    var body: some View {
        CardForm {
            CardSection(island ? "Dynamic Island" : "Live Activities",
                        footer: "iOS chooses the presentation based on your device and other active tasks. These previews don't start a Live Activity; approvals happen in Kith.") {
                VStack(spacing: 14) {
                    if forms.count > 1 {
                        ChoicePicker(selection: Binding(get: { form ?? forms[0] }, set: { form = $0 }), options: forms.map { ($0, $0.rawValue) })
                    }
                    if let bot = Bot.widgetPreview.first {
                        BotActivityPreview(bot: bot, state: state, form: form ?? forms[0], startedAt: startedAt)
                            .frame(maxWidth: .infinity, minHeight: 90)
                            .padding(12)
                            .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    SegmentedChoice(selection: $phase, options: [
                        (.working, "Running"), (.needsInput, "Needs you"), (.completed, "Done"),
                    ])
                }
                Toggle(isOn: $enabled) {
                    switchLabel("Live Activities", "a task's progress on the Lock Screen", symbol: "rectangle.on.rectangle")
                }
                .toggleStyle(.kithGreen)
                Toggle(isOn: $enabled) {
                    switchLabel("Dynamic Island", "the same task around the camera", symbol: "capsule")
                }
                .toggleStyle(.kithGreen)
                if !allowed {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Live Activities are turned off in iOS Settings.")
                            .font(.footnote).foregroundStyle(Palette.muted)
                        Button("Open iOS Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                            .buttonStyle(.plain)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Palette.accent)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 14) {
                ForEach(forms, id: \.self) { explanation($0) }
            }
        }
        .tint(Palette.accent)
        .onChange(of: enabled) { _, value in if !value { LiveActivities.shared.endAll() } }
        .onChange(of: scenePhase) { _, value in
            if value == .active { allowed = ActivityAuthorizationInfo().areActivitiesEnabled }
        }
    }

    private func switchLabel(_ title: String, _ detail: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).frame(width: 24).foregroundStyle(Palette.muted)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).foregroundStyle(Palette.ink)
                Text(detail).font(.caption).foregroundStyle(Palette.muted)
            }
        }
    }

    private func explanation(_ form: BotActivityPreview.Form) -> some View {
        let detail = switch form {
        case .lockScreen: "The bot, its current step, and the running time. When the bot needs you, Review opens the request."
        case .compact: "The bot beside the camera, with the running time or Needs you."
        case .minimal: "Just the bot, when iOS displays multiple Live Activities."
        case .expanded: "Touch and hold the Dynamic Island for the current step and the running time, or Review when the bot needs you. Tap to open the conversation."
        }
        return VStack(alignment: .leading, spacing: 4) {
            Text(form.rawValue).font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
            Text(detail).font(.footnote).foregroundStyle(Palette.muted)
        }
    }
}

struct LockWidgetGalleryView: View {
    @State private var kind = "bots"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ChoicePicker(selection: $kind, options: [("bots", "Bots"), ("usage", "Usage limits")])
                Text("Sample data").font(.caption).foregroundStyle(Palette.secondary)
                ForEach(AccessoryWidgetCard.Family.allCases, id: \.self) { family in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(family.rawValue).font(.subheadline.weight(.medium))
                        AccessoryWidgetCard(kind: kind == "bots" ? .bots : .usage, family: family,
                                            bots: Bot.widgetPreview, usage: .widgetPreview)
                            .frame(width: family == .circular ? 64 : family == .rectangular ? 160 : nil,
                                   height: family == .inline ? 24 : 64)
                            .padding(16).foregroundStyle(.white)
                            .background(.black, in: RoundedRectangle(cornerRadius: 20))
                            .environment(\.colorScheme, .dark)
                    }
                }
                Text("Touch and hold your Lock Screen → Customize → Lock Screen. Tap the widget area and choose Kith. Inline widgets go in the date row above the clock.")
                    .font(.footnote).foregroundStyle(Palette.secondary)
                Text("Choose Bots for task status or Usage limits for the highest reported limit. iOS applies your Lock Screen's color and style.")
                    .font(.footnote).foregroundStyle(Palette.secondary)
            }
            .padding(18).frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        .background(Palette.background)
        .page("Lock Screen widgets", pushed: true)
    }
}
