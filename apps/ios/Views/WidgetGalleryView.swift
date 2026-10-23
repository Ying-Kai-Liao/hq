import KithKit
import KithUI
import SwiftUI
import WidgetKit

/// The State tab's Widget page. The installed widgets and these previews share their rendering components.
struct WidgetGalleryView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page: Page?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var kind = "bots"
    @State private var providerID = "claude"
    @State private var size = "medium"
    /// The names of the Kith widgets on the Home or Lock Screen; nil until checked.
    @State private var installed: [String]?
    @State private var widgetCheckFailed = false
    @State private var showDemo = false
    /// nil until asked, false once turned off in the Settings app. Not asked during onboarding: offered here.
    @State private var notificationsAllowed: Bool?
    @AppStorage(SharedStore.usageIconStyleKey, store: UserDefaults(suiteName: SharedStore.appGroup))
    private var usageIconStyle = UsageIconStyle.character.rawValue

    /// Sample data where there is some, else what the computer last reported.
    private var provider: UsageProvider? {
        (Usage.widgetPreview.providers + SharedStore.activeContext.usage.values.flatMap(\.providers)).first { $0.id == providerID }
    }
    private var providers: [(id: String, label: String)] {
        let reported = SharedStore.activeContext.usageProviders
        var names = Dictionary(uniqueKeysWithValues: reported.map { ($0.id, $0.name) })
        // Keep both built-in providers selectable even when the shared snapshot is empty/stale.
        for provider in Usage.widgetPreview.providers where names[provider.id] == nil {
            names[provider.id] = provider.name
        }
        return names.map { (id: $0.key, label: $0.value) }.sorted { $0.label < $1.label }
    }

    private static let looks: [(id: String, title: String, detail: String, symbol: String)] = [
        ("bots", "Bots", "who needs you, what's running", "bubble.left.and.bubble.right"),
        ("team", "Team", "four bots you pick", "person.2"),
        ("limits", "Usage limits", "highest limit, every provider", "chart.bar"),
        ("provider", "Provider usage", "Claude Code, Codex, or any provider", "gauge.with.dots.needle.33percent"),
    ]

    /// Team is one size; the limits widget has two.
    private var sizes: [(id: String, label: String)] {
        let all = [("small", "Small"), ("medium", "Medium"), ("large", "Large")]
        return kind == "limits" ? Array(all.prefix(2)) : all
    }
    private var shownSize: String { kind == "team" ? "small" : kind == "limits" && size == "large" ? "medium" : size }

    var body: some View {
        CardForm {
            Text("Your bots and usage, on every surface.")
                .kithText(.body).foregroundStyle(Palette.muted)

            VStack(alignment: .leading, spacing: 14) {
                preview
                if kind != "team" {
                    SegmentedChoice(selection: $size, options: sizes)
                }
                if kind == "provider" {
                    if typeSize.isAccessibilitySize || providers.count > 3 {
                        ChoicePicker(selection: $providerID, options: providers)
                    } else {
                        SegmentedChoice(selection: $providerID, options: providers)
                    }
                }
                previewDescription
            }

            CardSection("Choose the look") {
                ForEach(Self.looks, id: \.id) { look in
                    Button { withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { kind = look.id } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: look.symbol).frame(width: 24).foregroundStyle(Palette.muted)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(look.title).foregroundStyle(Palette.ink)
                                Text(look.detail).font(.caption).foregroundStyle(Palette.muted)
                            }
                            Spacer(minLength: 8)
                            if kind == look.id {
                                Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.ink)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(kind == look.id ? .isSelected : [])
                }
            }

            CardSection("Usage icon", footer: "Applies to Usage in the app. Widgets name the provider in text.") {
                ForEach([(UsageIconStyle.character, "Character"), (UsageIconStyle.original, "Original icon")], id: \.0) { style, title in
                    Button {
                        usageIconStyle = style.rawValue
                        WidgetCenter.shared.reloadTimelines(ofKind: "KithProviderUsage")
                    } label: {
                        HStack {
                            Text(title).foregroundStyle(Palette.ink)
                            Spacer(minLength: 8)
                            if usageIconStyle == style.rawValue {
                                Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.ink)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(usageIconStyle == style.rawValue ? .isSelected : [])
                }
            }

            CardSection("Add it", footer: "Widgets show the latest report. Open Kith for live updates and approvals.") {
                Button { withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { showDemo.toggle() } } label: {
                    stepRow("On the Home Screen", "touch and hold → Edit → Add widget → Kith", symbol: "sparkles")
                }
                .buttonStyle(.plain)
                Button { page = .lockScreen } label: {
                    HStack {
                        stepRow("On the Lock Screen", "Customize → Lock Screen → widget area", symbol: "lock.rectangle")
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Toggle(isOn: Binding(get: { notificationsAllowed == true }, set: { _ in turnOnNotifications() })) {
                    HStack(spacing: 12) {
                        Image(systemName: "bell").frame(width: 24).foregroundStyle(Palette.muted)
                        Text("Notifications").foregroundStyle(Palette.ink)
                    }
                }
                .toggleStyle(.kithGreen)
                .accessibilityHint("Know when a bot is done or needs you.")
            }

            if showDemo { WidgetSetupDemo() }

            CardSection("Check") {
                HStack(spacing: 12) {
                    Image(systemName: installed?.isEmpty == false ? "checkmark" : "circle")
                        .frame(width: 24).foregroundStyle(installed?.isEmpty == false ? Palette.positive : Palette.muted)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Widgets").foregroundStyle(Palette.ink)
                        Text(checkDetail).font(.caption).foregroundStyle(Palette.muted)
                    }
                    Spacer(minLength: 8)
                    if widgetCheckFailed {
                        Button("Check again") { checkWidgets() }.buttonStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .navigationDestination(item: $page) { page in
            switch page {
            case .lockScreen: LockWidgetGalleryView()
            }
        }
        .hidesSystemNavigationBar()
        .task {
            checkWidgets()
            await checkNotifications()
        }
        .onChange(of: kind) { _, _ in if !sizes.contains(where: { $0.id == size }) { size = "small" } }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            checkWidgets()
            Task { await checkNotifications() }
        }
    }

    private enum Page: Hashable { case lockScreen }

    private var checkDetail: String {
        if widgetCheckFailed { return "Couldn't check your widgets. You can still add one with the steps above." }
        guard let installed else { return "Checking your widgets…" }
        return installed.isEmpty ? "None added yet" : "\(installed.count) added · \(installed.joined(separator: ", "))"
    }

    private var previewDescription: some View {
        Text(kind == "provider" ? "Small shows up to three windows. Medium and large add reset times and more windows."
             : kind == "limits" ? "Small shows the highest limit with its bar. Medium adds every provider's windows."
             : kind == "team" ? "Four bots with a name and state. Touch and hold the widget, then Edit Widget to choose who sits in each spot; empty spots show the bots that need you first."
             : "See who needs you and who's still working. Large shows up to six bots.")
            .kithText(.secondary).foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The widget on a soft wallpaper, as it would sit on the Home Screen.
    private var preview: some View {
        ZStack(alignment: .topTrailing) {
            LinearGradient(colors: [Color(light: 0xCFE0FB, dark: 0x252E4A), Color(light: 0xE4D8F7, dark: 0x2E2748), Color(light: 0xFBDCCB, dark: 0x3A2B3B)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            widget
                .padding(18)
                .frame(maxWidth: .infinity)
            Text("Sample data")
                .font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(WidgetStyle.ground.opacity(0.85), in: Capsule())
                .padding(10)
        }
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    @ViewBuilder private var widget: some View {
        let small = shownSize == "small"
        Group {
            switch kind {
            case "provider":
                if let provider {
                    ProviderWidgetCard(provider: provider, layout: shownSize == "large" ? .large : small ? .small : .medium,
                                       computer: "Mac mini")
                }
            case "limits":
                UsageLimitsCard(usage: .widgetPreview, medium: !small, computer: "Mac mini")
            case "team":
                BotsTeamCard(bots: Bot.widgetPreview)
            default:
                BotsWidgetCard(bots: Bot.widgetPreview, wide: !small, large: shownSize == "large")
            }
        }
        .padding(14)
        .frame(width: small ? 158 : nil, height: shownSize == "large" ? 338 : 158)
        .frame(maxWidth: small ? 158 : .infinity)
        .background(WidgetStyle.ground, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(shownSize.capitalized) widget preview")
    }

    private func stepRow(_ title: String, _ detail: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).frame(width: 24).foregroundStyle(Palette.muted)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).foregroundStyle(Palette.ink)
                Text(detail).font(.caption).foregroundStyle(Palette.muted).lineLimit(2)
            }
            Spacer(minLength: 8)
        }
        .contentShape(Rectangle())
    }

    private func checkNotifications() async {
        let allowed = await PushRegistrar.shared.isAllowed()
        withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { notificationsAllowed = allowed }
    }

    /// Asks once; after a no, only the Settings app can turn them on.
    private func turnOnNotifications() {
        if notificationsAllowed != nil {
            UIApplication.shared.open(URL(string: UIApplication.openNotificationSettingsURLString)!)
        } else {
            Task {
                _ = await PushRegistrar.shared.requestAuthorization()
                await checkNotifications()
            }
        }
    }

    private func checkWidgets() {
        let animation = Motion.reduced(Motion.layout, reduceMotion)
        withAnimation(animation) { widgetCheckFailed = false }
        WidgetCenter.shared.getCurrentConfigurations { result in
            let kinds = (try? result.get())?.map(\.kind).filter { $0.hasPrefix("Kith") }
            Task { @MainActor in
                withAnimation(animation) {
                    installed = kinds.map { Self.names(of: $0) }
                    widgetCheckFailed = kinds == nil
                }
            }
        }
    }

    /// Distinct widget names, in the order the gallery lists them.
    private static func names(of kinds: [String]) -> [String] {
        let names = ["KithBots": "Bots", "KithTeam": "Team", "KithUsage": "Usage limits",
                     "KithProviderUsage": "Provider usage", "KithClaudeUsage": "Provider usage", "KithCodexUsage": "Provider usage"]
        var seen: [String] = []
        for kind in kinds.sorted() { if let name = names[kind], !seen.contains(name) { seen.append(name) } }
        return seen
    }
}
