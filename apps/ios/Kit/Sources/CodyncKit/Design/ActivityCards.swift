import SwiftUI

public extension BotActivityPresentation {
    var orbState: ThinkingOrb.State? {
        switch phase {
        case .working: .working
        case .needsInput: .listening
        case .waiting, .stale: .connecting
        case .completed, .failed: nil
        }
    }

    var tint: Color {
        switch phase {
        case .needsInput: Palette.attention
        case .failed: Palette.danger
        case .completed: Palette.added
        case .stale, .waiting: Palette.secondary
        case .working: Palette.text
        }
    }

    /// The caption stays quiet while the bot works and takes the state's color otherwise.
    var captionTint: Color { phase == .working ? Palette.secondary : tint }

    var mood: CharacterAvatar.Mood {
        switch phase {
        case .working: .working
        case .needsInput: .needsInput
        case .completed, .failed, .stale, .waiting: .idle
        }
    }

    /// The elapsed time counts up on its own (no push) while the task is live.
    func elapsedStart(_ startedAt: Date?) -> Date? {
        phase == .working || phase == .needsInput ? startedAt : nil
    }
}

public extension AnyTransition {
    /// The bot's face on a phase change: the old one grows out, the new one grows in.
    static var activityFace: AnyTransition {
        .asymmetric(insertion: .scale(scale: 0.55).combined(with: .opacity),
                    removal: .scale(scale: 1.15).combined(with: .opacity))
    }

    /// Rows a new phase brings (the Review button, the timer): rise and fade in.
    static var activityRow: AnyTransition {
        .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity)
    }
}

/// The bot's face in its phase's mood, swapped with a pop when the phase changes.
public struct ActivityAvatar: View {
    let shape: String
    let color: String
    let state: BotActivityPresentation
    let size: CGFloat

    public init(shape: String, color: String, state: BotActivityPresentation, size: CGFloat) {
        self.shape = shape; self.color = color; self.state = state; self.size = size
    }

    public var body: some View {
        ZStack {
            CharacterAvatar(shape: shape, color: color, size: size, mood: state.mood, still: true)
                .id(state.phase)
                .transition(.activityFace)
        }
        .frame(width: size, height: size)
        .animation(Motion.activityPhase, value: state.phase)
    }
}

/// The step (or state) in its color, then the running time.
public struct ActivityCaption: View {
    let state: BotActivityPresentation
    let startedAt: Date?

    public init(state: BotActivityPresentation, startedAt: Date?) {
        self.state = state; self.startedAt = startedAt
    }

    public var body: some View {
        HStack(spacing: 4) {
            Text(state.caption)
                .foregroundStyle(state.captionTint)
                .contentTransition(.interpolate)
            // The step truncates first; the time always stays whole.
            if let since = state.elapsedStart(startedAt) {
                Text("·").foregroundStyle(Palette.tertiary)
                Text(since, style: .timer).monospacedDigit().foregroundStyle(Palette.secondary)
                    .fixedSize().layoutPriority(1)
            }
        }
        .font(.system(size: 12))
        .lineLimit(1)
    }
}

/// Opens the conversation on the request; approval itself stays on the permission card.
public struct ActivityReviewButton: View {
    let state: BotActivityPresentation
    let link: URL?

    public init(state: BotActivityPresentation, link: URL?) {
        self.state = state; self.link = link
    }

    public var body: some View {
        if let link { Link(destination: link) { label } } else { label }
    }

    private var label: some View {
        Label("Review", systemImage: "hand.raised.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Palette.onAccent)
            .frame(maxWidth: .infinity, minHeight: 34)
            .background(state.tint, in: Capsule())
    }
}

/// Shared by the Lock Screen Live Activity and the in-app gallery.
public struct BotActivityCard: View {
    let name: String
    let shape: String
    let color: String
    let state: BotActivityPresentation
    let startedAt: Date?
    let link: URL?

    public init(bot: Bot, state: BotActivityPresentation, startedAt: Date? = nil) {
        self.init(name: bot.name, shape: bot.avatarShape, color: bot.avatarColor, state: state, startedAt: startedAt)
    }

    public init(name: String, shape: String, color: String, state: BotActivityPresentation, startedAt: Date? = nil, link: URL? = nil) {
        self.name = name
        self.shape = shape
        self.color = color
        self.state = state
        self.startedAt = startedAt
        self.link = link
    }

    public var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                ActivityAvatar(shape: shape, color: color, state: state, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                    ActivityCaption(state: state, startedAt: startedAt)
                }
                Spacer(minLength: 8)
                BotActivityIndicator(state: state, size: 28)
            }
            if state.phase == .needsInput {
                ActivityReviewButton(state: state, link: link).transition(.activityRow)
            }
        }
        .padding(16)
        .animation(Motion.activityPhase, value: state)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(state.title). \(state.caption)")
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
        Group {
            if let orb = state.orbState {
                ThinkingOrb(state: orb, size: size, color: state.tint, animated: false)
            } else {
                Image(systemName: state.symbol).font(.system(size: size * 0.6, weight: .semibold))
                    .transition(.activityFace)
            }
        }
        .frame(width: size, height: size)
        .foregroundStyle(state.tint)
        .animation(Motion.activityPhase, value: state.phase)
        .accessibilityElement()
        .accessibilityLabel(state.title)
    }
}

/// The expanded island's bottom row: Review while the bot needs you, else the running time.
public struct ActivityIslandFooter: View {
    let state: BotActivityPresentation
    let startedAt: Date?
    let link: URL?

    public init(state: BotActivityPresentation, startedAt: Date?, link: URL?) {
        self.state = state; self.startedAt = startedAt; self.link = link
    }

    public var body: some View {
        Group {
            if state.phase == .needsInput {
                ActivityReviewButton(state: state, link: link)
            } else if let since = state.elapsedStart(startedAt) {
                Label { Text(since, style: .timer).monospacedDigit() } icon: { Image(systemName: "timer") }
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .transition(.activityRow)
        .animation(Motion.activityPhase, value: state)
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
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22))
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
                ActivityAvatar(shape: bot.avatarShape, color: bot.avatarColor, state: state, size: 20)
                Spacer(minLength: 70)
                BotActivityIndicator(state: state)
            }
            .padding(.horizontal, 12).frame(width: 210, height: 38)
            .background(.black, in: Capsule())
        case .minimal:
            BotActivityIndicator(state: state)
                .frame(width: 38, height: 38).background(.black, in: Circle())
        case .expanded:
            VStack(spacing: 12) {
                HStack(spacing: 10) {
                    ActivityAvatar(shape: bot.avatarShape, color: bot.avatarColor, state: state, size: 26)
                    VStack(spacing: 2) {
                        Text(bot.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                        Text(state.caption).font(.system(size: 12)).foregroundStyle(state.captionTint)
                    }
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
                    BotActivityIndicator(state: state, size: 28)
                }
                ActivityIslandFooter(state: state, startedAt: startedAt, link: nil)
            }
            .padding(18).background(.black, in: RoundedRectangle(cornerRadius: 28))
        case .lockScreen: EmptyView()
        }
    }
}
