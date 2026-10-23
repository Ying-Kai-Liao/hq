import AppIntents
import SwiftUI
import WidgetKit

/// The widget kit (app-style/widgets): white or coal ground, ink for what needs you, Nunito names,
/// JetBrains Mono figures, Inter labels. The extension does not bundle the fonts, so each falls back to
/// the system's rounded or monospaced face.
public enum WidgetStyle {
    /// Home Screen widget background: white, coal in dark.
    public static let ground = Color(light: 0xFFFFFF, dark: 0x1E2129)
    public static let track = Color(light: 0xEEEFF3, dark: 0x2C303A)

    /// A bot's name: Nunito 800.
    public static func name(_ size: CGFloat) -> Font {
        KithFonts.isAvailable(KithFonts.nunitoExtraBold)
            ? .custom(KithFonts.nunitoExtraBold, size: size)
            : .system(size: size, weight: .heavy, design: .rounded)
    }

    /// Figures: JetBrains Mono 500.
    public static func mono(_ size: CGFloat) -> Font {
        KithFonts.isAvailable(KithFonts.jetBrainsMono)
            ? .custom(KithFonts.jetBrainsMono, size: size).weight(.medium)
            : .system(size: size, weight: .medium, design: .monospaced)
    }

    /// Labels: Inter.
    public static func label(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let face = weight == .bold ? KithFonts.interBold : weight == .regular ? KithFonts.interRegular : KithFonts.interSemiBold
        return KithFonts.isAvailable(face) ? .custom(face, size: size) : .system(size: size, weight: weight)
    }
}

/// The count of bots that need you: an ink disc with a white figure.
public struct WidgetBadge: View {
    let count: Int
    var size: CGFloat = 18

    public init(_ count: Int, size: CGFloat = 18) { self.count = count; self.size = size }

    public var body: some View {
        Text("\(count)")
            .font(WidgetStyle.label(size * 11 / 18, .bold))
            .foregroundStyle(Palette.onAccent)
            .minimumScaleFactor(0.7)
            .frame(width: size, height: size)
            .background(Palette.ink, in: Circle())
            .widgetAccentable()
            .accessibilityHidden(true)
    }
}

/// Three hop dots for a bot at work (a widget cannot animate): ink, the first two fading.
public struct WidgetHopDots: View {
    public init() {}
    public var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(Palette.ink.opacity(i == 2 ? 1 : i == 1 ? 0.55 : 0.25)).frame(width: 4, height: 4)
            }
        }
        .widgetAccentable()
        .accessibilityHidden(true)
    }
}

/// A usage bar: 5 pt, ink on a pale track.
public struct UsageBar: View {
    let percent: Double

    public init(percent: Double) { self.percent = percent }

    public var body: some View {
        let value = percent.isFinite ? min(100, max(0, percent)) : 0
        Capsule().fill(WidgetStyle.track)
            .frame(height: 5)
            .overlay(alignment: .leading) {
                GeometryReader { geometry in
                    Capsule().fill(Palette.ink).frame(width: max(5, geometry.size.width * value / 100))
                }
            }
            .widgetAccentable()
            .accessibilityElement()
            .accessibilityLabel("Usage")
            .accessibilityValue("\(Int(value.rounded())) percent")
    }
}

/// A bot standing on the widget: its soft shadow and no tile. Tinted and clear Home Screens draw the
/// bot as a flat silhouette that takes the accent.
public struct WidgetBot: View {
    @Environment(\.widgetRenderingMode) private var mode
    let bot: Bot
    let size: CGFloat

    public init(_ bot: Bot, size: CGFloat) { self.bot = bot; self.size = size }

    public var body: some View {
        Group {
            if mode == .fullColor {
                CharacterAvatar(bot: bot, size: size, still: true).kithBotShadow()
            } else {
                CharacterAvatar(bot: bot, size: size, still: true).brightness(-1).widgetAccentable()
            }
        }
    }
}

extension Bot {
    fileprivate var isDoneToday: Bool {
        status == "idle" && lastAt > 0 && Calendar.current.isDateInToday(Date(milliseconds: lastAt))
    }
    fileprivate var urgency: Int { needsInput ? 0 : isWorking ? 1 : 2 }
}

/// Shared by the widget extension and its in-app gallery so previews use the
/// same typography, spacing and progress rendering as the installed widget.
public struct ProviderWidgetCard: View {
    public enum Layout { case small, medium, large }
    let provider: UsageProvider
    let layout: Layout
    let date: Date
    let iconStyle: UsageIconStyle
    let computer: String?

    public init(provider: UsageProvider, layout: Layout, date: Date = .now, iconStyle: UsageIconStyle = SharedStore.usageIconStyle, computer: String? = nil) {
        self.provider = provider
        self.layout = layout
        self.date = date
        self.iconStyle = iconStyle
        self.computer = computer
    }

    private var windows: ArraySlice<UsageWindow> { provider.windows.prefix(layout == .large ? 5 : 3) }

    public var body: some View {
        VStack(alignment: .leading, spacing: layout == .small ? 9 : 11) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Text names only, no logos.
                Text(provider.name).font(WidgetStyle.label(13, .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                Spacer(minLength: 4)
                if let computer {
                    Text(computer).font(WidgetStyle.label(10)).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            ForEach(windows) { window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(window.title).font(WidgetStyle.label(11)).foregroundStyle(Palette.muted).lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(Int(window.percent.rounded()))%")
                            .font(WidgetStyle.mono(13)).foregroundStyle(Palette.ink)
                            .contentTransition(.numericText(value: window.percent))
                    }
                    UsageBar(percent: window.percent)
                    if layout != .small, let reset = window.resetsShort(now: date) {
                        Text(reset).font(WidgetStyle.label(9)).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetAccentable()
        // A new timeline entry rolls the numbers instead of swapping.
        .animation(Motion.activityPhase, value: provider)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(provider.name) usage")
        .accessibilityValue(accessibleUsage)
    }

    private var accessibleUsage: String {
        windows.map { window in
            "\(window.title), \(Int(window.percent.rounded())) percent" +
                (window.resetsShort(now: date).map { ", \($0)" } ?? "")
        }.joined(separator: "; ")
    }
}

/// Fine, separated ticks keep low and high usage legible without a heavy gauge.
public struct UsageTicks: View {
    let percent: Double
    let tint: Color
    let height: CGFloat

    public init(percent: Double, tint: Color, height: CGFloat = 16) {
        self.percent = percent
        self.tint = tint
        self.height = height
    }

    public var body: some View {
        GeometryReader { geometry in
            let count = max(1, Int(geometry.size.width / 4))
            let value = percent.isFinite ? min(100, max(0, percent)) : 0
            let filled = Int((Double(count) * value / 100).rounded())
            let color = value >= 90 ? Palette.danger : tint
            HStack(spacing: 1.5) {
                ForEach(0..<count, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(i < filled ? color : color.opacity(0.16))
                }
            }
        }
        .frame(height: height)
        .accessibilityLabel("Usage")
        .accessibilityValue("\(Int((percent.isFinite ? percent : 0).rounded())) percent")
    }
}


/// Usage limits: the highest limit as a mono percent with its bar and reset; the medium widget adds
/// a row with a bar for each provider window. Shared by the widget and the gallery.
public struct UsageLimitsCard: View {
    let usage: Usage
    let medium: Bool
    let computer: String?
    let date: Date

    public init(usage: Usage, medium: Bool, computer: String? = nil, date: Date = .now) {
        self.usage = usage; self.medium = medium; self.computer = computer; self.date = date
    }

    private var windows: [(provider: String, window: UsageWindow)] {
        usage.providers.flatMap { p in p.windows.map { (p.name, $0) } }
    }
    private var top: (provider: String, window: UsageWindow)? { windows.max { $0.window.percent < $1.window.percent } }

    public var body: some View {
        if let top {
            Group {
                if medium {
                    HStack(alignment: .top, spacing: 18) {
                        hero(top).frame(width: 118, alignment: .leading)
                        VStack(alignment: .leading, spacing: 9) {
                            ForEach(Array(windows.prefix(4).enumerated()), id: \.offset) { _, item in bar(item) }
                            Spacer(minLength: 0)
                        }
                    }
                } else {
                    hero(top).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .animation(Motion.activityPhase, value: usage)
        }
    }

    /// The highest limit: a mono percent, its name and, on the small widget, its bar and reset.
    private func hero(_ item: (provider: String, window: UsageWindow)) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text("Usage limits").font(WidgetStyle.label(13, .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                Spacer(minLength: 4)
                if !medium, let computer {
                    Text(computer).font(WidgetStyle.label(10)).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text("\(Int(item.window.percent.rounded()))").font(WidgetStyle.mono(34))
                    .contentTransition(.numericText(value: item.window.percent))
                Text("%").font(WidgetStyle.mono(16)).foregroundStyle(Palette.muted)
            }
            .foregroundStyle(Palette.ink)
            .minimumScaleFactor(0.7)
            Text(medium ? "\(item.window.label) · highest" : "\(item.provider) · \(item.window.label)")
                .font(WidgetStyle.label(11)).foregroundStyle(Palette.muted).lineLimit(1)
            if !medium {
                UsageBar(percent: item.window.percent).padding(.top, 6)
            }
            resetLine(item.window).font(WidgetStyle.label(10)).foregroundStyle(Palette.muted).lineLimit(1)
                .padding(.top, medium ? 4 : 2)
        }
        .widgetAccentable()
    }

    private func bar(_ item: (provider: String, window: UsageWindow)) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(item.provider) \(item.window.label)").font(WidgetStyle.label(11)).foregroundStyle(Palette.muted).lineLimit(1)
                Spacer(minLength: 4)
                Text("\(Int(item.window.percent.rounded()))%").font(WidgetStyle.mono(11)).foregroundStyle(Palette.ink)
            }
            UsageBar(percent: item.window.percent)
        }
    }

    /// "resets Mon 9:00"
    @ViewBuilder private func resetLine(_ w: UsageWindow) -> some View {
        if let reset = w.resetDate, reset > date {
            Text("resets \(reset.formatted(.dateTime.weekday(.abbreviated).hour().minute()))")
        } else if let text = w.resetDescription {
            Text(text)
        } else {
            Text(" ")
        }
    }
}
public extension UsageProvider {
    var widgetTint: Color { id == "codex" ? Color(light: 0x326FAD, dark: 0x70ACDC) : tint }
}

public extension Usage {
    /// Illustrative data only: widget placeholders and explicitly labelled previews.
    static var widgetPreview: Usage {
        let json = """
        {"providers":[{"id":"claude","name":"Claude","source":"claude","updatedAt":0,"windows":[
          {"id":"five_hour","label":"5-hour","percent":16,"resetsText":"3h 20m"},{"id":"seven_day","label":"Weekly","percent":59,"resetsText":"2d 6h"}]},
         {"id":"codex","name":"Codex","source":"sessions","updatedAt":0,"windows":[
          {"id":"primary","label":"5-hour","percent":8,"resetsText":"2h 10m"},{"id":"secondary","label":"Weekly","percent":27,"resetsText":"4d 2h"}]}]}
        """
        return (try? JSONDecoder().decode(Usage.self, from: Data(json.utf8))) ?? Usage()
    }
}

public struct BotsWidgetCard: View {
    let bots: [Bot]
    let wide: Bool
    let large: Bool
    let links: [String: URL]

    public init(bots: [Bot], wide: Bool, large: Bool = false, links: [String: URL] = [:]) {
        self.bots = bots.filter { !$0.hidden }
        self.wide = wide
        self.large = large
        self.links = links
    }

    private var ordered: [Bot] {
        bots.sorted { $0.urgency == $1.urgency ? $0.lastAt > $1.lastAt : $0.urgency < $1.urgency }
    }
    private var needs: Int { bots.filter(\.needsInput).count }
    private var busy: Int { bots.filter(\.isWorking).count }
    private var working: Int { bots.filter { $0.isWorking && !$0.needsInput }.count }
    private var doneToday: Int { bots.filter(\.isDoneToday).count }
    private var count: Int { needs > 0 ? needs : working > 0 ? working : bots.count }
    private var label: String { needs > 0 ? (needs == 1 ? "needs you" : "need you") : working > 0 ? "working" : bots.isEmpty ? "No bots yet" : "All quiet" }
    /// "6 bots · 2 working"
    private var totals: String {
        let total = "\(bots.count) \(bots.count == 1 ? "bot" : "bots")"
        return busy > 0 ? "\(total) · \(busy) working" : total
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if large {
                HStack(alignment: .firstTextBaseline) {
                    title
                    Spacer()
                    Text("\(bots.count) total · \(busy) working")
                        .font(WidgetStyle.label(11)).foregroundStyle(Palette.muted)
                }
                HStack(alignment: .top, spacing: 22) {
                    figure(needs, "need you")
                    figure(working, "working")
                    figure(doneToday, "done today")
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 2)
                botRows(limit: 6)
                Spacer(minLength: 0)
            } else if wide {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 0) {
                        title
                        Spacer(minLength: 4)
                        summary
                        Text(totals).font(WidgetStyle.label(11)).foregroundStyle(Palette.muted)
                            .padding(.top, 6)
                    }
                    .frame(width: 104, alignment: .leading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    botRows(limit: 3)
                }
            } else {
                HStack {
                    title
                    Spacer(minLength: 4)
                    if needs > 0 { WidgetBadge(needs) }
                }
                HStack(spacing: 3) {
                    ForEach(ordered.prefix(3)) { bot in WidgetBot(bot, size: 44) }
                    Spacer(minLength: 0)
                }
                Spacer(minLength: 0)
                summary
                Text(totals).font(WidgetStyle.label(11)).foregroundStyle(Palette.muted).lineLimit(1)
            }
        }
        .foregroundStyle(Palette.ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // A new timeline entry moves rows into their new order and morphs counts and states.
        .animation(Motion.activityPhase, value: bots)
    }

    private var title: some View {
        Text("Bots").font(WidgetStyle.label(13, .semibold)).widgetAccentable()
    }

    private func figure(_ value: Int, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(value)").font(WidgetStyle.mono(28)).widgetAccentable()
                .contentTransition(.numericText(value: Double(value)))
            Text(caption).font(WidgetStyle.label(11)).foregroundStyle(Palette.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private func botRows(limit: Int) -> some View {
        VStack(alignment: .leading, spacing: large ? 9 : 8) {
            ForEach(ordered.prefix(limit)) { bot in
                Group {
                    if let link = links[bot.id] {
                        Link(destination: link) { row(bot) }
                    } else { row(bot) }
                }
                .transition(.activityRow)
            }
            if bots.isEmpty {
                Text("Create your first bot in Kith.")
                    .font(WidgetStyle.label(12)).foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(count)").font(WidgetStyle.mono(34)).widgetAccentable()
                .contentTransition(.numericText(value: Double(count)))
            Text(label).font(WidgetStyle.label(13)).foregroundStyle(Palette.muted)
                .contentTransition(.interpolate)
        }
        .accessibilityElement(children: .combine)
    }

    /// Name and step on the left, the state on the right: a badge, hop dots, Done or asleep.
    private func row(_ bot: Bot) -> some View {
        HStack(spacing: 9) {
            WidgetBot(bot, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(bot.name).font(WidgetStyle.name(13)).foregroundStyle(Palette.ink)
                if let line = bot.widgetLine {
                    Text(line).font(WidgetStyle.label(11, bot.needsInput ? .semibold : .regular))
                        .foregroundStyle(bot.needsInput ? Palette.ink : Palette.muted)
                        .contentTransition(.interpolate)
                }
            }
            .lineLimit(1)
            Spacer(minLength: 4)
            stateMark(bot)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(bot.name), \(bot.widgetState.label)")
    }

    @ViewBuilder private func stateMark(_ bot: Bot) -> some View {
        if bot.needsInput {
            WidgetBadge(max(1, bot.unread))
        } else if bot.status == "error" {
            Text("Failed").font(WidgetStyle.label(11, .semibold)).foregroundStyle(Palette.negative)
        } else if bot.isWorking {
            WidgetHopDots()
        } else if bot.isDoneToday {
            Text("Done").font(WidgetStyle.label(11, .semibold)).foregroundStyle(Palette.positive)
        } else {
            Text("asleep").font(WidgetStyle.label(11)).foregroundStyle(Palette.muted)
        }
    }
}

public extension Bot {
    /// The state word the widgets and the control show, and its colour: ink when it needs you; red
    /// (failed) and green (done) only ever stand beside the word.
    var widgetState: (label: String, tint: Color) {
        if needsInput { return ("Needs you", Palette.ink) }
        if status == "error" { return ("Failed", Palette.negative) }
        if isWorking { return ("Working", Palette.ink) }
        if isDoneToday { return ("Done", Palette.positive) }
        return ("Ready", Palette.muted)
    }
}

extension Bot {
    /// The second line of a bot row: the question or step, else its last message.
    fileprivate var widgetLine: String? {
        let text = isWorking ? activity : (lastMessage ?? "")
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.isEmpty ? (needsInput ? "Needs you" : nil) : line
    }
}

/// Four bots in a 2×2 grid with a name and state under each; a badge on the bot's top right when it
/// needs you. Spots picked in the widget's settings keep their bot; the rest fill with the bots that
/// need you first, and empty spots hold a faded sleeping character.
public struct BotsTeamCard: View {
    let slots: [Bot?]
    let opens: [String: any AppIntent]

    /// `opens` (bot id → the intent that opens its conversation) makes each spot a button.
    public init(bots: [Bot], picks: [String?] = [], opens: [String: any AppIntent] = [:]) {
        slots = Self.slots(bots: bots, picks: picks)
        self.opens = opens
    }

    /// The bots in their four spots: picks first (a deleted pick falls back to automatic).
    public static func slots(bots: [Bot], picks: [String?]) -> [Bot?] {
        let byId = Dictionary(bots.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let picked = (0..<4).map { i in i < picks.count ? picks[i].flatMap { byId[$0] } : nil }
        let taken = Set(picked.compactMap { $0?.id })
        var queue = bots.filter { !$0.hidden && !taken.contains($0.id) }.sorted {
            $0.urgency == $1.urgency ? $0.lastAt > $1.lastAt : $0.urgency < $1.urgency
        }[...]
        return picked.map { $0 ?? queue.popFirst() }
    }

    public var body: some View {
        Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            GridRow { tile(0); tile(1) }
            GridRow { tile(2); tile(3) }
        }
        // A new timeline entry lets each bot change its mood in place.
        .animation(Motion.activityPhase, value: slots)
    }

    @ViewBuilder private func tile(_ index: Int) -> some View {
        if let bot = slots[index] {
            // A small widget has one tap target unless it uses buttons: each spot is a
            // button that opens its bot's conversation.
            if let open = opens[bot.id] {
                Button(intent: open) { botTile(bot) }.buttonStyle(.plain)
            } else {
                botTile(bot)
            }
        } else {
            CharacterAvatar(portrait: "crew-builder", size: 40, still: true)
                .opacity(0.18)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityHidden(true)
        }
    }

    private func botTile(_ bot: Bot) -> some View {
        VStack(spacing: 2) {
            WidgetBot(bot, size: 40)
                .overlay(alignment: .topTrailing) {
                    if bot.needsInput { WidgetBadge(max(1, bot.unread), size: 16).offset(x: 6, y: -4) }
                }
            Text(bot.name).font(WidgetStyle.name(11)).foregroundStyle(Palette.ink)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(bot.widgetState.label == "Ready" ? "asleep" : bot.widgetState.label.lowercased())
                .font(WidgetStyle.label(9)).foregroundStyle(bot.status == "error" ? Palette.negative : Palette.muted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bot.name), \(bot.widgetState.label)")
    }
}

public extension Bot {
    static var widgetPreview: [Bot] {
        let json = """
        [{"id":"preview-review","name":"Reviewer","avatarShape":"blob","avatarColor":"green","backend":"claude","cwd":"/","status":"needsInput","activity":"Review changes","lastAt":3},
         {"id":"preview-build","name":"Builder","avatarShape":"squircle","avatarColor":"orange","backend":"codex","cwd":"/","status":"working","activity":"Running tests","lastAt":2},
         {"id":"preview-docs","name":"Docs","avatarShape":"hex","avatarColor":"gray","backend":"claude","cwd":"/","status":"idle","lastAt":1}]
        """
        return (try? JSONDecoder().decode([Bot].self, from: Data(json.utf8))) ?? []
    }
}
