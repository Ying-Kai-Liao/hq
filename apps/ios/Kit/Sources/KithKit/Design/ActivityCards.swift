import SwiftUI

public extension BotActivityPresentation {
    var orbState: ThinkingOrb.State? {
        switch phase {
        case .working: .working
        case .needsInput: .listening
        case .sending, .waiting, .stale: .connecting
        case .queued, .completed, .failed: nil
        }
    }

    var tint: Color {
        switch phase {
        case .needsInput: Palette.ink
        case .failed: Palette.negative
        case .completed: Palette.positive
        case .sending, .queued, .stale, .waiting: Palette.muted
        case .working: Palette.ink
        }
    }

    /// The caption stays quiet while the bot works and takes the state's color otherwise.
    var captionTint: Color { phase == .working ? Palette.secondary : tint }

    var mood: CharacterAvatar.Mood {
        switch phase {
        case .sending, .queued, .working: .working
        case .needsInput: .needsInput
        case .failed: .error
        case .completed, .stale, .waiting: .idle
        }
    }

    /// The elapsed time counts up on its own (no push) while the task is live.
    func elapsedStart(_ startedAt: Date?) -> Date? {
        phase == .working || phase == .needsInput ? startedAt : nil
    }
}

public extension AnyTransition {
    /// Rows a new phase brings (the Review button, the timer): rise and fade in.
    static var activityRow: AnyTransition {
        .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)
    }
}

/// The bot's body in its phase's mood: one still frame (widgets and Live Activities cannot run
/// animation), the eyes posed for the phase. A nil portrait is a group's cube.
public struct ActivityAvatar: View {
    let color: String
    let state: BotActivityPresentation
    let size: CGFloat
    let portrait: String?

    public init(color: String, portrait: String? = nil, state: BotActivityPresentation, size: CGFloat) {
        self.color = color; self.portrait = portrait; self.state = state; self.size = size
    }

    public var body: some View {
        CharacterAvatar(portrait: portrait, color: color, size: size, mood: state.mood, still: true)
    }
}

/// The caption under the name: the step while the bot works, "Needs you · <question>" in ink when it
/// waits, else the state's word in its colour. The running time sits on the card's right.
public struct ActivityCaption: View {
    let state: BotActivityPresentation
    let startedAt: Date?

    public init(state: BotActivityPresentation, startedAt: Date?) {
        self.state = state; self.startedAt = startedAt
    }

    public var body: some View {
        Text(state.widgetCaption)
            .font(WidgetStyle.label(12, state.phase == .needsInput ? .semibold : .regular))
            .foregroundStyle(state.captionTint)
            .contentTransition(.interpolate)
            .lineLimit(1)
    }
}

public extension BotActivityPresentation {
    /// "Running tests", or "Needs you · <question>" while the bot waits on you.
    var widgetCaption: String {
        guard phase == .needsInput, !activity.isEmpty, activity != title else { return caption }
        return "\(title) · \(activity)"
    }
}

/// Opens the conversation on the request; approval itself stays on the permission card. An ink
/// pill (white on the black island).
public struct ActivityReviewButton: View {
    let state: BotActivityPresentation
    let link: URL?
    let onBlack: Bool

    public init(state: BotActivityPresentation, link: URL?, onBlack: Bool = false) {
        self.state = state; self.link = link; self.onBlack = onBlack
    }

    public var body: some View {
        if let link { Link(destination: link) { label } } else { label }
    }

    private var label: some View {
        Text("Review")
            .font(WidgetStyle.label(12, .semibold))
            .foregroundStyle(onBlack ? Color.black : Palette.onAccent)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 14)
            .frame(height: 30)
            .background(onBlack ? Color.white : Palette.ink, in: Capsule())
    }
}

/// The card's right side: Review while the bot needs you, else the running time in mono.
public struct ActivityTrailing: View {
    let state: BotActivityPresentation
    let startedAt: Date?
    let link: URL?
    let onBlack: Bool

    public init(state: BotActivityPresentation, startedAt: Date?, link: URL?, onBlack: Bool = false) {
        self.state = state; self.startedAt = startedAt; self.link = link; self.onBlack = onBlack
    }

    public var body: some View {
        Group {
            if state.phase == .needsInput {
                ActivityReviewButton(state: state, link: link, onBlack: onBlack)
            } else if let since = state.elapsedStart(startedAt) {
                // No fixedSize on a timer Text: a Live Activity can't lay one out at its ideal width
                // and draws the whole card black. Unconstrained, it takes the width left over.
                Text(since, style: .timer)
                    .font(WidgetStyle.mono(15))
                    .monospacedDigit()
                    .foregroundStyle(onBlack ? Color.white : Palette.ink)
                    .multilineTextAlignment(.trailing)
            }
        }
        .transition(.activityRow)
    }
}

/// Shared by the Lock Screen Live Activity and the in-app gallery. The Live Activity passes its
/// own face and mark (the working loops drawn in timer fonts); the gallery uses the still ones.
/// The thread title and project a thread has are not in the activity's state, so the footer
/// carries the mark (hop dots) or, when the bot waits, the time.
public struct BotActivityCard<Face: View, Mark: View>: View {
    let name: String
    let state: BotActivityPresentation
    let startedAt: Date?
    let link: URL?
    let face: Face
    let mark: Mark

    public init(name: String, state: BotActivityPresentation, startedAt: Date? = nil, link: URL? = nil,
                @ViewBuilder face: () -> Face, @ViewBuilder mark: () -> Mark) {
        self.name = name
        self.state = state
        self.startedAt = startedAt
        self.link = link
        self.face = face()
        self.mark = mark()
    }

    public var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                face.kithBotShadow()
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(WidgetStyle.name(16)).foregroundStyle(Palette.ink).lineLimit(1)
                    ActivityCaption(state: state, startedAt: startedAt)
                }
                .layoutPriority(1)
                Spacer(minLength: 8)
                ActivityTrailing(state: state, startedAt: startedAt, link: link)
            }
            HStack {
                Spacer(minLength: 0)
                if state.phase == .needsInput, let since = state.elapsedStart(startedAt) {
                    Text(since, style: .timer).font(WidgetStyle.mono(11)).monospacedDigit()
                        .foregroundStyle(Palette.muted).multilineTextAlignment(.trailing)
                } else {
                    mark
                }
            }
        }
        .padding(14)
        .animation(Motion.activityPhase, value: state)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(state.title). \(state.caption)")
    }
}

public extension BotActivityCard where Face == ActivityAvatar, Mark == BotActivityIndicator {
    init(bot: Bot, state: BotActivityPresentation, startedAt: Date? = nil) {
        self.init(name: bot.name, state: state, startedAt: startedAt) {
            ActivityAvatar(color: bot.avatarColor, portrait: CrewAvatar.asset(for: bot), state: state, size: 42)
        } mark: {
            BotActivityIndicator(state: state, size: 16)
        }
    }
}


/// The state mark: a thinking orb while the task is live, a symbol once it has ended
/// (errors and delayed updates never look complete).
public struct BotActivityIndicator: View {
    let state: BotActivityPresentation
    let size: CGFloat

    public init(state: BotActivityPresentation, size: CGFloat = 20) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        // The orb and the end symbols cross-fade; the bot beside it carries the motion.
        ZStack {
            Group {
                if state.orbState != nil {
                    // A frame cannot animate the orb: three still hop dots stand for "working".
                    WidgetHopDots()
                } else {
                    Image(systemName: state.symbol).font(.system(size: size * 0.6, weight: .semibold))
                }
            }
            .id(state.phase)
            .transition(.opacity)
        }
        .frame(width: size, height: size)
        .foregroundStyle(state.tint)
        .animation(Motion.activityPhase, value: state.phase)
        .accessibilityElement()
        .accessibilityLabel(state.title)
    }
}

/// The working indicator of the Dynamic Island and Lock Screen: Kith's hop, drawn by the KithHop
/// fonts (apps/ios/tools/make-kith-glyph-fonts.py). A Live Activity cannot run an animation, but
/// a timer redraws every second, so the fonts map each digit to a pose and draw only the timer's
/// last digit (every other character shapes to nothing): the text is one face wide however the
/// system lays out timer text, and the bot steps through ten poses, one a second.
public struct HopFrames: View {
    let content: Text
    let color: Color
    let size: CGFloat

    /// `content` is the timer (`Text(since, style: .timer)`) while the bot works, or one digit for
    /// a still pose (`Text("0")` is the resting frame, used with Reduce Motion).
    public init(_ content: Text, color: Color, size: CGFloat) {
        self.content = content; self.color = color; self.size = size
    }

    public var body: some View {
        ZStack {
            layer("KithHop-Ghost").foregroundStyle(color.opacity(0.3))
            layer("KithHop-Dot").foregroundStyle(color)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func layer(_ font: String) -> some View {
        content
            .font(.custom(font, fixedSize: size))
            // Western digits whatever the region: the fonts only have those.
            .environment(\.locale, Locale(identifier: "en_US_POSIX"))
            .lineLimit(1)
            .frame(width: size, height: size)
            .clipped()
    }
}

/// The expanded island's bottom row: the hop dots (the `mark`) while the bot works, the time while it
/// waits on you. Always on black.
public struct ActivityIslandFooter<Mark: View>: View {
    let state: BotActivityPresentation
    let startedAt: Date?
    let mark: Mark

    public init(state: BotActivityPresentation, startedAt: Date?, @ViewBuilder mark: () -> Mark) {
        self.state = state; self.startedAt = startedAt; self.mark = mark()
    }

    public var body: some View {
        HStack {
            Spacer(minLength: 0)
            if state.phase == .needsInput, let since = state.elapsedStart(startedAt) {
                Text(since, style: .timer).font(WidgetStyle.mono(11)).monospacedDigit()
                    .foregroundStyle(Color(hex: 0xB4BAC4)).multilineTextAlignment(.trailing)
            } else {
                mark
            }
        }
        .transition(.activityRow)
        .animation(Motion.activityPhase, value: state)
    }
}

/// The island's compact trailing side: a mono timer while the bot works, "Needs you" when it waits,
/// else the state's word.
public struct ActivityCompactLabel: View {
    let state: BotActivityPresentation
    let startedAt: Date?

    public init(state: BotActivityPresentation, startedAt: Date?) {
        self.state = state; self.startedAt = startedAt
    }

    public var body: some View {
        Group {
            if state.phase == .needsInput {
                Text("Needs you").font(WidgetStyle.label(12, .semibold)).foregroundStyle(.white)
            } else if let since = state.elapsedStart(startedAt) {
                Text(since, style: .timer).font(WidgetStyle.mono(12)).monospacedDigit()
                    .foregroundStyle(.white).multilineTextAlignment(.trailing)
            } else {
                Text(state.title)
                    .font(WidgetStyle.label(12, .semibold))
                    .foregroundStyle(state.phase == .failed ? Palette.negative : state.phase == .completed ? Palette.positive : Color(hex: 0xB4BAC4))
            }
        }
        .lineLimit(1)
    }
}

/// Illustrations for the gallery/exporter, using the same activity content views.
/// The real Dynamic Island's regions and camera cutout are laid out by iOS.
public struct BotActivityPreview: View {
    public enum Form: String, CaseIterable {
        case lockScreen = "Lock Screen", compact = "Compact", minimal = "Minimal", expanded = "Expanded"
    }
    let bot: Bot
    let state: BotActivityPresentation
    let form: Form
    let startedAt: Date?

    public init(bot: Bot, state: BotActivityPresentation, form: Form, startedAt: Date? = nil) {
        self.bot = bot; self.state = state; self.form = form; self.startedAt = startedAt
    }

    public var body: some View {
        Group {
            if form == .lockScreen {
                BotActivityCard(bot: bot, state: state, startedAt: startedAt)
                    .background(WidgetStyle.ground, in: RoundedRectangle(cornerRadius: 22))
            } else {
                island.environment(\.colorScheme, .dark)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(form.rawValue) preview")
    }

    @ViewBuilder private var island: some View {
        switch form {
        case .compact:
            HStack {
                islandFace(24)
                Spacer(minLength: 70)
                ActivityCompactLabel(state: state, startedAt: startedAt)
            }
            .padding(.horizontal, 12).frame(width: 210, height: 38)
            .background(.black, in: Capsule())
        case .minimal:
            islandFace(24)
                .frame(width: 38, height: 38).background(.black, in: Circle())
        case .expanded:
            VStack(spacing: 10) {
                HStack(spacing: 12) {
                    islandFace(44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(bot.name).font(WidgetStyle.name(16)).foregroundStyle(.white)
                        Text(state.widgetCaption).font(WidgetStyle.label(12, state.phase == .needsInput ? .semibold : .regular))
                            .foregroundStyle(state.phase == .needsInput ? Color.white : Color(hex: 0xB4BAC4))
                    }
                    .lineLimit(1)
                    Spacer(minLength: 8)
                    ActivityTrailing(state: state, startedAt: startedAt, link: nil, onBlack: true)
                }
                ActivityIslandFooter(state: state, startedAt: startedAt) {
                    BotActivityIndicator(state: state, size: 16)
                }
            }
            .padding(18).background(.black, in: RoundedRectangle(cornerRadius: 28))
        case .lockScreen: EmptyView()
        }
    }

    @ViewBuilder private func islandFace(_ size: CGFloat) -> some View {
        ActivityAvatar(color: bot.avatarColor, portrait: CrewAvatar.asset(for: bot), state: state, size: size)
    }
}
