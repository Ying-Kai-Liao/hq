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
        case .needsInput: Color(light: 0x936000, dark: 0xECAF52)
        case .failed: Palette.danger
        case .completed: Palette.added
        case .stale, .waiting: Palette.secondary
        case .working: Palette.text
        }
    }
}

/// Shared by the Lock Screen Live Activity and the in-app gallery.
public struct BotActivityCard: View {
    let name: String
    let shape: String
    let color: String
    let state: BotActivityPresentation

    public init(bot: Bot, state: BotActivityPresentation) {
        self.init(name: bot.name, shape: bot.avatarShape, color: bot.avatarColor, state: state)
    }

    public init(name: String, shape: String, color: String, state: BotActivityPresentation) {
        self.name = name
        self.shape = shape
        self.color = color
        self.state = state
    }

    public var body: some View {
        HStack(spacing: 12) {
            CharacterAvatar(shape: shape, color: color, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
                Text(state.caption).font(.system(size: 12)).foregroundStyle(Palette.secondary)
            }
            .lineLimit(1)
            Spacer(minLength: 8)
            BotActivityIndicator(state: state, size: 28)
        }
        .padding(16)
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
            }
        }
        .frame(width: size, height: size)
        .foregroundStyle(state.tint)
        .accessibilityElement()
        .accessibilityLabel(state.title)
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

    public init(bot: Bot, state: BotActivityPresentation, form: Form) {
        self.bot = bot; self.state = state; self.form = form
    }

    public var body: some View {
        Group {
            if form == .lockScreen {
                BotActivityCard(bot: bot, state: state)
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
                CharacterAvatar(bot: bot, size: 20, animated: false)
                Spacer(minLength: 70)
                BotActivityIndicator(state: state)
            }
            .padding(.horizontal, 12).frame(width: 210, height: 38)
            .background(.black, in: Capsule())
        case .minimal:
            BotActivityIndicator(state: state)
                .frame(width: 38, height: 38).background(.black, in: Circle())
        case .expanded:
            HStack(spacing: 10) {
                CharacterAvatar(bot: bot, size: 26, animated: false)
                VStack(spacing: 2) {
                    Text(bot.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                    Text(state.caption).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                BotActivityIndicator(state: state, size: 28)
            }
            .padding(18).background(.black, in: RoundedRectangle(cornerRadius: 28))
        case .lockScreen: EmptyView()
        }
    }
}
