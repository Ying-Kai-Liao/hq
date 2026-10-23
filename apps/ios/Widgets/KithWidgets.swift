import ActivityKit
import AppIntents
import KithKit
import SwiftUI
import WidgetKit

@main
struct KithWidgets: WidgetBundle {
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
    var bots: [Bot]
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

    /// Only one computer's bots; nil keeps every computer.
    func on(_ computerId: ComputerID?) -> BotsEntry {
        guard let computerId else { return self }
        var entry = self
        entry.bots = bots.filter { $0.id.hasPrefix("\(computerId)/") }
        return entry
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
        StaticConfiguration(kind: "KithBots", provider: BotsTimeline()) { entry in
            BotsWidgetView(entry: entry)
                .containerBackground(WidgetStyle.ground, for: .widget)
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
                Text("Connect Kith to your computer")
            case .accessoryCircular:
                Image(systemName: "desktopcomputer")
                    .accessibilityLabel("Connect Kith to your computer")
            case .accessoryRectangular:
                Label("Connect a computer", systemImage: "desktopcomputer")
                    .font(.caption)
            default:
                EmptyWidget(text: "Open Kith to pair with your computer.")
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

/// Up to four bots as characters in a 2×2 grid; Edit Widget picks the bot in each spot.
struct BotsTeamWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "KithTeam", intent: TeamIntent.self, provider: TeamTimeline()) { entry in
            Group {
                if entry.bots.paired {
                    // Each spot opens its own bot; the gaps between them open the app.
                    BotsTeamCard(bots: entry.bots.bots, picks: entry.picks, opens: entry.bots.links.mapValues { OpenBotIntent($0) })
                } else {
                    EmptyWidget(text: "Open Kith to pair with your computer.")
                }
            }
            .containerBackground(WidgetStyle.ground, for: .widget)
        }
        .configurationDisplayName("Team")
        .description("Four bots at a glance. Edit the widget to choose the computer and who sits in each spot.")
        .supportedFamilies([.systemSmall])
    }
}

/// A computer of the selected account; the Team widget shows only its bots.
struct ComputerEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Computer"
    static let defaultQuery = ComputerEntityQuery()

    let id: ComputerID
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ComputerEntityQuery: EntityQuery {
    private var all: [ComputerEntity] {
        SharedStore.activeContext.computers.map { ComputerEntity(id: $0.id, name: $0.name) }
    }

    func entities(for identifiers: [ComputerID]) async throws -> [ComputerEntity] {
        let all = all
        return identifiers.compactMap { id in all.first { $0.id == id } }
    }

    func suggestedEntities() async throws -> [ComputerEntity] { all }
}

/// A bot of the selected account, keyed `<computerId>/<botId>` like the widget snapshot.
struct BotEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Bot"
    static let defaultQuery = BotEntityQuery()

    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct BotEntityQuery: EntityQuery {
    /// The widget's computer: the spot pickers list only its bots.
    @IntentParameterDependency<TeamIntent>(\.$computer) var team

    private var all: [BotEntity] {
        BotsEntry.current.on(team?.computer.id).bots.filter { !$0.hidden }.map { BotEntity(id: $0.id, name: $0.name) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func entities(for identifiers: [String]) async throws -> [BotEntity] {
        let all = all
        return identifiers.compactMap { id in all.first { $0.id == id } }
    }

    func suggestedEntities() async throws -> [BotEntity] { all }
}

struct TeamIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Team"
    static let description = IntentDescription("Choose a computer and a bot for each spot; empty spots show the bots that need you.")

    @Parameter(title: "Computer") var computer: ComputerEntity?
    @Parameter(title: "Top left") var first: BotEntity?
    @Parameter(title: "Top right") var second: BotEntity?
    @Parameter(title: "Bottom left") var third: BotEntity?
    @Parameter(title: "Bottom right") var fourth: BotEntity?

    var picks: [String?] { [first?.id, second?.id, third?.id, fourth?.id] }
}

struct TeamEntry: TimelineEntry {
    let date: Date
    let bots: BotsEntry
    let picks: [String?]
}

struct TeamTimeline: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TeamEntry {
        TeamEntry(date: .now, bots: BotsEntry(date: .now, bots: Bot.widgetPreview, paired: true), picks: [])
    }

    func snapshot(for configuration: TeamIntent, in context: Context) async -> TeamEntry {
        context.isPreview ? placeholder(in: context) : TeamEntry(date: .now, bots: BotsEntry.current.on(configuration.computer?.id), picks: configuration.picks)
    }

    /// The app writes the roster and reloads this widget when a bot's state changes.
    func timeline(for configuration: TeamIntent, in context: Context) async -> Timeline<TeamEntry> {
        Timeline(entries: [TeamEntry(date: .now, bots: BotsEntry.current.on(configuration.computer?.id), picks: configuration.picks)], policy: .never)
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
        StaticControlConfiguration(kind: "KithLeadBot", provider: LeadBotProvider()) { lead in
            ControlWidgetButton(action: OpenURLIntent(lead.url)) {
                Label(lead.text, systemImage: lead.symbol)
            }
            // Filled white when someone needs you, plain otherwise.
            .tint(lead.needsYou ? .white : nil)
        }
        .displayName("Bots")
        .description("The bot that needs you most. Tap to open it.")
    }
}

struct LeadBot: Sendable {
    let text: String
    let symbol: String
    let url: URL
    var needsYou = false

    static let home = AppEnvironment.current.link("computers")

    init(text: String, symbol: String, url: URL = LeadBot.home, needsYou: Bool = false) {
        self.text = text; self.symbol = symbol; self.url = url; self.needsYou = needsYou
    }

    init(_ entry: BotsEntry) {
        guard entry.paired else { self.init(text: "Connect a computer", symbol: "desktopcomputer"); return }
        guard let bot = entry.lead, bot.isWorking else { self.init(text: "All quiet", symbol: "moon.zzz.fill"); return }
        self.init(text: "\(bot.name) · \(bot.widgetState.label)",
                  symbol: bot.needsInput ? "hand.raised.fill" : "ellipsis.bubble.fill",
                  url: entry.links[bot.id] ?? LeadBot.home, needsYou: bot.needsInput)
    }
}

struct LeadBotProvider: ControlValueProvider {
    var previewValue: LeadBot { LeadBot(text: "Reviewer · Needs you", symbol: "hand.raised.fill", needsYou: true) }

    func currentValue() async throws -> LeadBot { LeadBot(.current) }
}

private struct EmptyWidget: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CharacterAvatar(portrait: "crew-builder", size: 40, still: true).kithBotShadow()
            Spacer(minLength: 0)
            Text(text).font(WidgetStyle.label(12)).foregroundStyle(Palette.muted)
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
        AppIntentConfiguration(kind: "KithUsage", intent: UsageIntent.self, provider: UsageTimeline()) { entry in
            UsageWidgetView(entry: entry)
                .containerBackground(WidgetStyle.ground, for: .widget)
        }
        .configurationDisplayName("Usage limits")
        .description("Subscription limits your computer reports, for every provider.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

/// The highest limit is the headline (after CodexBar); the medium widget lists every window
/// with its bar.
struct UsageWidgetView: View {
    let entry: UsageEntry
    @Environment(\.widgetFamily) private var family

    private var hasUsage: Bool { entry.usage.providers.contains { !$0.windows.isEmpty } }

    /// The computer the usage comes from: the last one the app used.
    private var computerName: String? {
        let storage = SharedStore.activeContext
        return storage.lastComputerId.flatMap { id in storage.computers.first { $0.id == id }?.name }
    }

    var body: some View {
        if hasUsage {
            switch family {
            case .accessoryInline:
                AccessoryWidgetCard(kind: .usage, family: .inline, usage: entry.usage).widgetAccentable()
            case .accessoryCircular:
                AccessoryWidgetCard(kind: .usage, family: .circular, usage: entry.usage).widgetAccentable()
            case .accessoryRectangular:
                AccessoryWidgetCard(kind: .usage, family: .rectangular, usage: entry.usage).widgetAccentable()
            default:
                UsageLimitsCard(usage: entry.usage, medium: family == .systemMedium, computer: computerName, date: entry.date)
            }
        } else if family == .accessoryInline || family == .accessoryCircular || family == .accessoryRectangular {
            Text("No usage yet")
        } else {
            EmptyWidget(text: SharedStore.activeContext.computers.isEmpty ? "Open Kith to pair with your computer." : "No usage reported yet.")
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
        AppIntentConfiguration(kind: "KithProviderUsage", intent: ProviderUsageIntent.self, provider: ProviderUsageTimeline()) { entry in
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
        StaticConfiguration(kind: "KithClaudeUsage", provider: FixedProviderUsageTimeline(providerID: "claude")) { entry in
            ProviderUsageView(entry: entry)
        }
        .configurationDisplayName("Claude Code")
        .description("Claude Code session and weekly usage limits.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct CodexUsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KithCodexUsage", provider: FixedProviderUsageTimeline(providerID: "codex")) { entry in
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
                ProviderWidgetCard(provider: provider, layout: family == .systemSmall ? .small : family == .systemLarge ? .large : .medium, date: entry.date,
                                   computer: SharedStore.activeContext.lastComputerId.flatMap { id in SharedStore.activeContext.computers.first { $0.id == id }?.name })
            } else {
                EmptyWidget(text: "Open Kith to connect a computer and check \(entry.provider.capitalized) usage.")
            }
        }
        .containerBackground(WidgetStyle.ground, for: .widget)
        .widgetURL(AppEnvironment.current.link("usage"))
    }
}

// MARK: - Live Activity

struct BotLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            let state = presentation(context)
            BotActivityCard(name: context.attributes.name, state: state,
                            startedAt: context.state.startedAt, link: context.attributes.link) {
                avatar(context, state: state, size: 42)
            } mark: {
                indicator(context, state: state, size: 16)
            }
            .modifier(SurfaceTint())
                .widgetURL(context.attributes.link ?? AppEnvironment.current.link("computers"))
        } dynamicIsland: { context in
            let state = presentation(context)
            let muted = Color(hex: 0xB4BAC4)
            // The island is always black: the bot is the only colour.
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    avatar(context, state: state, size: 44).frame(maxHeight: .infinity)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ActivityTrailing(state: state, startedAt: context.state.startedAt, link: context.attributes.link, onBlack: true)
                        .frame(maxHeight: .infinity)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.name).font(WidgetStyle.name(16)).foregroundStyle(.white)
                        Text(state.widgetCaption)
                            .font(WidgetStyle.label(12, state.phase == .needsInput ? .semibold : .regular))
                            .foregroundStyle(state.phase == .needsInput ? Color.white : muted)
                            .contentTransition(.interpolate)
                    }
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .animation(Motion.activityPhase, value: state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityIslandFooter(state: state, startedAt: context.state.startedAt) {
                        indicator(context, state: state, size: 16)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                avatar(context, state: state, size: 24)
            } compactTrailing: {
                ActivityCompactLabel(state: state, startedAt: context.state.startedAt)
            } minimal: {
                avatar(context, state: state, size: 24)
                    .accessibilityLabel("\(context.attributes.name), \(state.title)")
            }
            .keylineTint(.clear)
            .widgetURL(context.attributes.link ?? AppEnvironment.current.link("computers"))
        }
    }

    private func presentation(_ context: ActivityViewContext<BotActivityAttributes>) -> BotActivityPresentation {
        .init(status: context.state.status, activity: context.state.activity, isStale: context.isStale)
    }

    /// While the bot works, the mark is Kith's hop (one pose a second); otherwise it holds its
    /// state's mark. With Reduce Motion the hop rests.
    @ViewBuilder
    private func indicator(_ context: ActivityViewContext<BotActivityAttributes>, state: BotActivityPresentation, size: CGFloat) -> some View {
        ZStack {
            if state.phase == .working {
                WorkingHop(since: context.state.startedAt ?? .now, color: state.tint, size: size)
                    .transition(.opacity)
            } else {
                BotActivityIndicator(state: state, size: size).transition(.opacity)
            }
        }
        .animation(Motion.activityPhase, value: state.phase)
        .accessibilityLabel(state.title)
    }

    /// The bot's body with its eyes posed for the phase: one frame, since a Live Activity cannot animate.
    private func avatar(_ context: ActivityViewContext<BotActivityAttributes>, state: BotActivityPresentation, size: CGFloat) -> some View {
        ActivityAvatar(color: context.attributes.avatarColor, portrait: context.attributes.avatarPortrait, state: state, size: size)
            .animation(Motion.activityPhase, value: state.phase)
    }
}

/// Kith's hop: the timer drawn in the KithHop fonts, resting under Reduce Motion.
struct WorkingHop: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let since: Date
    let color: Color
    let size: CGFloat

    var body: some View {
        HopFrames(reduceMotion ? Text("0") : Text(since, style: .timer), color: color, size: size)
    }
}

/// The Lock Screen card's ground, painted by the card itself in its own color scheme. The
/// system's tint alone can draw light under dark text (the Mac's menu bar shows it that way),
/// leaving the name white on white.
private struct SurfaceTint: ViewModifier {
    @Environment(\.self) private var environment

    func body(content: Content) -> some View {
        let surface = Color(WidgetStyle.ground.resolve(in: environment))
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(surface)
            .activityBackgroundTint(surface)
    }
}
