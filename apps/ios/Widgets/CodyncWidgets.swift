import ActivityKit
import AppIntents
import CodyncKit
import SwiftUI
import WidgetKit

@main
struct CodyncWidgets: WidgetBundle {
    var body: some Widget {
        BotsWidget()
        BotsTeamWidget()
        LeadBotControl()
        UsageWidget()
        ProviderUsageWidget()
        ClaudeUsageWidget()
        CodexUsageWidget()
        BotLiveActivity()
    }
}

// MARK: - Bots at a glance

struct BotsEntry: TimelineEntry {
    let date: Date
    let bots: [Bot]
    let paired: Bool
    var links: [String: URL] = [:]

    /// The app's snapshot of every computer's bots in the selected account. Bot IDs are only
    /// unique per computer, so each copy is re-keyed `<computerId>/<botId>` for the cards and links.
    static var current: BotsEntry {
        let storage = SharedStore.activeContext
        var bots: [Bot] = []
        var links: [String: URL] = [:]
        for snapshot in storage.bots {
            var bot = snapshot.bot
            bot.id = "\(snapshot.computerId)/\(snapshot.bot.id)"
            links[bot.id] = storage.botURL(BotReference(accountId: storage.accountID, computerId: snapshot.computerId, botId: snapshot.bot.id))
            bots.append(bot)
        }
        return BotsEntry(date: .now, bots: bots, paired: !storage.computers.isEmpty, links: links)
    }
}

struct BotsTimeline: TimelineProvider {
    func placeholder(in context: Context) -> BotsEntry { BotsEntry(date: .now, bots: Bot.widgetPreview, paired: true) }

    func getSnapshot(in context: Context, completion: @escaping (BotsEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : .current)
    }

    /// The app writes the roster and reloads this widget when a bot's state changes.
    func getTimeline(in context: Context, completion: @escaping (Timeline<BotsEntry>) -> Void) {
        completion(Timeline(entries: [.current], policy: .never))
    }
}

struct BotsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CodyncBots", provider: BotsTimeline()) { entry in
            BotsWidgetView(entry: entry)
                .containerBackground(Palette.surface, for: .widget)
        }
        .configurationDisplayName("Bots")
        .description("Bots that need you, running tasks, and their current activity.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct BotsWidgetView: View {
    let entry: BotsEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if !entry.paired {
            switch family {
            case .accessoryInline:
                Text("Connect Codync to your computer")
            case .accessoryCircular:
                Image(systemName: "desktopcomputer")
                    .accessibilityLabel("Connect Codync to your computer")
            case .accessoryRectangular:
                Label("Connect a computer", systemImage: "desktopcomputer")
                    .font(.caption)
            default:
                EmptyWidget(text: "Open Codync to pair with your computer.")
            }
        } else {
            switch family {
            case .accessoryInline:
                AccessoryWidgetCard(kind: .bots, family: .inline, bots: entry.bots).widgetAccentable()
            case .accessoryCircular:
                AccessoryWidgetCard(kind: .bots, family: .circular, bots: entry.bots).widgetAccentable()
            case .accessoryRectangular:
                AccessoryWidgetCard(kind: .bots, family: .rectangular, bots: entry.bots).widgetAccentable()
            case .systemLarge:
                BotsWidgetCard(bots: entry.bots, wide: true, large: true, links: entry.links)
            case .systemMedium:
                BotsWidgetCard(bots: entry.bots, wide: true, links: entry.links)
            default:
                BotsWidgetCard(bots: entry.bots, wide: false)
                    .widgetURL(entry.lead.flatMap { entry.links[$0.id] })
            }
        }
    }

}

/// Up to four bots as characters in a 2×2 grid.
struct BotsTeamWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CodyncTeam", provider: BotsTimeline()) { entry in
            Group {
                if entry.paired {
                    BotsTeamCard(bots: entry.bots)
                        .widgetURL(entry.lead.flatMap { entry.links[$0.id] })
                } else {
                    EmptyWidget(text: "Open Codync to pair with your computer.")
                }
            }
            .containerBackground(Palette.surface, for: .widget)
        }
        .configurationDisplayName("Team")
        .description("Four bots at a glance; the ones that need you come first.")
        .supportedFamilies([.systemSmall])
    }
}

extension BotsEntry {
    /// Needs you first, then working, then most recent.
    var lead: Bot? {
        bots.filter { !$0.hidden }.min {
            let rank = { (b: Bot) in b.needsInput ? 0 : b.isWorking ? 1 : 2 }
            return rank($0) != rank($1) ? rank($0) < rank($1) : $0.lastAt > $1.lastAt
        }
    }
}

// MARK: - Control Center

/// A Control Center button: the bot that needs you most and its state; a tap opens it.
struct LeadBotControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "CodyncLeadBot", provider: LeadBotProvider()) { lead in
            ControlWidgetButton(action: OpenURLIntent(lead.url)) {
                Label(lead.text, systemImage: lead.symbol)
            }
        }
        .displayName("Bots")
        .description("The bot that needs you most. Tap to open it.")
    }
}

struct LeadBot: Sendable {
    let text: String
    let symbol: String
    let url: URL

    static let home = URL(string: "codync://computers")!

    init(text: String, symbol: String, url: URL = LeadBot.home) {
        self.text = text; self.symbol = symbol; self.url = url
    }

    init(_ entry: BotsEntry) {
        guard entry.paired else { self.init(text: "Connect a computer", symbol: "desktopcomputer"); return }
        guard let bot = entry.lead, bot.isWorking else { self.init(text: "All quiet", symbol: "moon.zzz.fill"); return }
        self.init(text: "\(bot.name): \(bot.widgetState.label)",
                  symbol: bot.needsInput ? "hand.raised.fill" : "ellipsis.bubble.fill",
                  url: entry.links[bot.id] ?? LeadBot.home)
    }
}

struct LeadBotProvider: ControlValueProvider {
    var previewValue: LeadBot { LeadBot(text: "Reviewer: Needs you", symbol: "hand.raised.fill") }

    func currentValue() async throws -> LeadBot { LeadBot(.current) }
}

private struct EmptyWidget: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CharacterAvatar(shape: "blob", color: "gray", size: 26, mood: .idle)
            Spacer(minLength: 0)
            Text(text).font(.caption).foregroundStyle(Palette.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Usage limits

struct UsageEntry: TimelineEntry {
    let date: Date
    let usage: Usage
}

struct UsageIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Usage limits"
}

struct UsageTimeline: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: .now, usage: .widgetPreview)
    }

    func snapshot(for configuration: UsageIntent, in context: Context) async -> UsageEntry {
        UsageEntry(date: .now, usage: context.isPreview ? .widgetPreview : (Self.cached ?? Usage()))
    }

    /// Refreshes every 30 minutes, or right after the next limit resets if that's sooner.
    func timeline(for configuration: UsageIntent, in context: Context) async -> Timeline<UsageEntry> {
        await Self.timeline()
    }

    static func timeline() async -> Timeline<UsageEntry> {
        let storage = SharedStore.activeContext
        let computer = storage.lastComputerId
        let fetched = await fetch(storage: storage)
        // The app switched account or computer meanwhile: redraw from the new one shortly.
        guard SharedStore.activeContext.id == storage.id, storage.lastComputerId == computer else {
            return Timeline(entries: [UsageEntry(date: .now, usage: Usage())], policy: .after(.now + 5))
        }
        let usage = fetched ?? cached ?? Usage()
        let nextReset = usage.providers.flatMap(\.windows).compactMap(\.resetDate).filter { $0 > .now }.min()
        var next = Date.now + (fetched == nil ? 5 * 60 : 30 * 60)
        if let nextReset, nextReset + 1 < next { next = max(nextReset + 1, .now + 5 * 60) }
        return Timeline(entries: [UsageEntry(date: .now, usage: usage)], policy: .after(next))
    }

    /// The last active computer's usage, as the app last saw it.
    static var cached: Usage? {
        let storage = SharedStore.activeContext
        return storage.lastComputerId.flatMap { storage.usage[$0] }
    }

    /// Asks the last active computer directly or through the relay, one call, then disconnects;
    /// nil falls back to the app's cache. `refresh` makes the host re-read the limits first.
    static func fetch(refresh: Bool = false, storage: SharedStore.Context = SharedStore.activeContext) async -> Usage? {
        // Keys exist once a computer is saved; the widget never creates them.
        guard let id = storage.lastComputerId, let computer = storage.computers.first(where: { $0.id == id }),
              let identity = try? DeviceIdentity.load(context: storage),
              let transport = try? await HostConnector.connect(computer, identity: identity) else { return nil }
        let usage = try? await HostClient(transport: transport).usage(refresh: refresh)
        await transport.shutdown()
        guard let usage, SharedStore.activeContext.id == storage.id, storage.lastComputerId == id else { return nil }
        storage.usage[id] = usage
        return usage
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "CodyncUsage", intent: UsageIntent.self, provider: UsageTimeline()) { entry in
            UsageWidgetView(entry: entry)
                .containerBackground(Palette.surface, for: .widget)
        }
        .configurationDisplayName("Usage limits")
        .description("Subscription limits your computer reports, for every provider.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

/// The tightest limit is the headline (after CodexBar); the rest are thin grey bars
/// that only take color near the limit.
struct UsageWidgetView: View {
    let entry: UsageEntry
    @Environment(\.widgetFamily) private var family

    private var windows: [(provider: String, window: UsageWindow)] {
        entry.usage.providers.flatMap { p in p.windows.map { (p.name, $0) } }
    }

    private var tightest: (provider: String, window: UsageWindow)? { windows.max { $0.window.percent < $1.window.percent } }
    private var rest: [(provider: String, window: UsageWindow)] {
        windows.filter { $0.window.id != tightest?.window.id || $0.provider != tightest?.provider }
    }

    var body: some View {
        if let top = tightest {
            switch family {
            case .accessoryInline:
                AccessoryWidgetCard(kind: .usage, family: .inline, usage: entry.usage).widgetAccentable()
            case .accessoryCircular:
                AccessoryWidgetCard(kind: .usage, family: .circular, usage: entry.usage).widgetAccentable()
            case .accessoryRectangular:
                AccessoryWidgetCard(kind: .usage, family: .rectangular, usage: entry.usage).widgetAccentable()
            case .systemMedium:
                HStack(alignment: .top, spacing: 18) {
                    hero(top).frame(width: 118, alignment: .leading)
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(Array(rest.prefix(4).enumerated()), id: \.offset) { _, item in bar(item) }
                        Spacer(minLength: 0)
                    }
                }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    hero(top)
                    Spacer(minLength: 6)
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(rest.prefix(2).enumerated()), id: \.offset) { _, item in bar(item) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if family == .accessoryInline || family == .accessoryCircular || family == .accessoryRectangular {
            Text("No usage yet")
        } else {
            EmptyWidget(text: SharedStore.activeContext.computers.isEmpty ? "Open Codync to pair with your computer." : "No usage reported yet.")
        }
    }

    private func hero(_ item: (provider: String, window: UsageWindow)) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(item.provider) · \(item.window.label)").font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
            Text(percent(item.window))
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(item.window.percent >= 90 ? Palette.danger : Palette.text)
                .minimumScaleFactor(0.7)
            resetLine(item.window).font(.caption2).foregroundStyle(Palette.tertiary).lineLimit(1)
        }
    }

    private func bar(_ item: (provider: String, window: UsageWindow)) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(item.provider) \(item.window.label)").lineLimit(1)
                Spacer(minLength: 4)
                Text(percent(item.window)).monospacedDigit()
            }
            .font(.caption2)
            .foregroundStyle(Palette.secondary)
            UsageTicks(percent: item.window.percent, tint: Palette.usageTint(item.window.percent), height: 10)
        }
    }

    private func percent(_ w: UsageWindow) -> String { "\(Int(w.percent.rounded()))%" }

    @ViewBuilder private func resetLine(_ w: UsageWindow) -> some View {
        if let date = w.resetDate, date > entry.date {
            Text("resets \(Text(date, style: .relative))")
        } else if let text = w.resetDescription {
            Text(text)
        } else {
            Text(" ")
        }
    }
}

// MARK: - One provider

/// Any provider a computer reports usage for, not a fixed list.
struct UsageProviderEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Provider"
    static let defaultQuery = UsageProviderQuery()

    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct UsageProviderQuery: EntityQuery {
    private var all: [UsageProviderEntity] {
        var names = Dictionary(uniqueKeysWithValues: SharedStore.activeContext.usageProviders.map { ($0.id, $0.name) })
        // The widget editor can ask the extension before it has a usable shared snapshot.
        // Seed the built-in choices from the same sample data used by widget previews.
        for provider in Usage.widgetPreview.providers where names[provider.id] == nil {
            names[provider.id] = provider.name
        }
        return names.map { UsageProviderEntity(id: $0.key, name: $0.value) }.sorted { $0.name < $1.name }
    }

    func entities(for identifiers: [String]) async throws -> [UsageProviderEntity] {
        let all = all
        return identifiers.map { id in all.first { $0.id == id } ?? UsageProviderEntity(id: id, name: id.capitalized) }
    }

    func suggestedEntities() async throws -> [UsageProviderEntity] { all }

    func defaultResult() async -> UsageProviderEntity? { all.first { $0.id == "claude" } ?? all.first }
}

struct ProviderUsageIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Provider usage"

    @Parameter(title: "Provider")
    var provider: UsageProviderEntity?
}

struct ProviderUsageEntry: TimelineEntry {
    let date: Date
    let usage: Usage
    let provider: String
}

struct ProviderUsageTimeline: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ProviderUsageEntry {
        ProviderUsageEntry(date: .now, usage: .widgetPreview, provider: "claude")
    }

    func snapshot(for configuration: ProviderUsageIntent, in context: Context) async -> ProviderUsageEntry {
        let usage = context.isPreview ? .widgetPreview : (UsageTimeline.cached ?? Usage())
        return ProviderUsageEntry(date: .now, usage: usage, provider: configuration.provider?.id ?? "claude")
    }

    func timeline(for configuration: ProviderUsageIntent, in context: Context) async -> Timeline<ProviderUsageEntry> {
        let shared = await UsageTimeline.timeline()
        return Timeline(entries: shared.entries.map { ProviderUsageEntry(date: $0.date, usage: $0.usage, provider: configuration.provider?.id ?? "claude") },
                        policy: shared.policy)
    }
}

struct ProviderUsageWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "CodyncProviderUsage", intent: ProviderUsageIntent.self, provider: ProviderUsageTimeline()) { entry in
            ProviderUsageView(entry: entry)
        }
        .configurationDisplayName("Provider usage")
        .description("Session and weekly limits in a compact, easy-to-read card.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

/// Fixed-provider widgets appear as separate choices in the iOS widget gallery.
struct ClaudeUsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CodyncClaudeUsage", provider: FixedProviderUsageTimeline(providerID: "claude")) { entry in
            ProviderUsageView(entry: entry)
        }
        .configurationDisplayName("Claude Code")
        .description("Claude Code session and weekly usage limits.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct CodexUsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CodyncCodexUsage", provider: FixedProviderUsageTimeline(providerID: "codex")) { entry in
            ProviderUsageView(entry: entry)
        }
        .configurationDisplayName("Codex")
        .description("Codex session and weekly usage limits.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct FixedProviderUsageTimeline: TimelineProvider {
    let providerID: String

    func placeholder(in context: Context) -> ProviderUsageEntry {
        ProviderUsageEntry(date: .now, usage: .widgetPreview, provider: providerID)
    }

    func getSnapshot(in context: Context, completion: @escaping (ProviderUsageEntry) -> Void) {
        let usage = context.isPreview ? Usage.widgetPreview : (UsageTimeline.cached ?? Usage())
        completion(ProviderUsageEntry(date: .now, usage: usage, provider: providerID))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ProviderUsageEntry>) -> Void) {
        let usage = UsageTimeline.cached ?? Usage()
        let entry = ProviderUsageEntry(date: .now, usage: usage, provider: providerID)
        completion(Timeline(entries: [entry], policy: .after(.now + 30 * 60)))
    }
}

/// Uses the exact same card as the in-app widget gallery.
struct ProviderUsageView: View {
    let entry: ProviderUsageEntry
    @Environment(\.widgetFamily) private var family
    private var provider: UsageProvider? { entry.usage.providers.first { $0.id == entry.provider } }

    var body: some View {
        Group {
            if let provider, !provider.windows.isEmpty {
                ProviderWidgetCard(provider: provider, layout: family == .systemSmall ? .small : family == .systemLarge ? .large : .medium, date: entry.date)
            } else {
                EmptyWidget(text: "Open Codync to connect a computer and check \(entry.provider.capitalized) usage.")
            }
        }
        .containerBackground(Palette.surface, for: .widget)
        .widgetURL(URL(string: "codync://usage"))
    }
}

// MARK: - Live Activity

struct BotLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            BotActivityCard(name: context.attributes.name, shape: context.attributes.avatarShape,
                            color: context.attributes.avatarColor, state: presentation(context),
                            startedAt: context.state.startedAt, link: context.attributes.link)
                .activityBackgroundTint(Palette.surface)
                .widgetURL(context.attributes.link ?? URL(string: "codync://computers"))
        } dynamicIsland: { context in
            let state = presentation(context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    avatar(context, state: state, size: 26).frame(maxHeight: .infinity)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    BotActivityIndicator(state: state, size: 28).frame(maxHeight: .infinity)
                }
                // Centered under the camera, between the avatar and the orb, so nothing reaches
                // the island's 44 pt corners (HIG: concentric margins, wrap around the camera).
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.attributes.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                        Text(state.caption).font(.system(size: 12)).foregroundStyle(state.captionTint)
                            .contentTransition(.interpolate)
                    }
                    .lineLimit(1)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .environment(\.colorScheme, .dark)
                    .animation(Motion.activityPhase, value: state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityIslandFooter(state: state, startedAt: context.state.startedAt, link: context.attributes.link)
                        .padding(.horizontal, 4)
                        .environment(\.colorScheme, .dark)
                }
            } compactLeading: {
                avatar(context, state: state, size: 20)
            } compactTrailing: {
                BotActivityIndicator(state: state).environment(\.colorScheme, .dark)
            } minimal: {
                BotActivityIndicator(state: state)
                    .environment(\.colorScheme, .dark)
                    .accessibilityLabel("\(context.attributes.name), \(state.title)")
            }
            .keylineTint(state.tint)
            .widgetURL(context.attributes.link ?? URL(string: "codync://computers"))
        }
    }

    private func presentation(_ context: ActivityViewContext<BotActivityAttributes>) -> BotActivityPresentation {
        .init(status: context.state.status, activity: context.state.activity, isStale: context.isStale)
    }

    private func avatar(_ context: ActivityViewContext<BotActivityAttributes>, state: BotActivityPresentation, size: CGFloat) -> some View {
        ActivityAvatar(shape: context.attributes.avatarShape, color: context.attributes.avatarColor, state: state, size: size)
    }
}
