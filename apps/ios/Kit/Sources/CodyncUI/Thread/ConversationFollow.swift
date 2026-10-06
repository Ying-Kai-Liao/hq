import CodyncKit
import SwiftUI

extension View {
    /// Reports whether the top of the content is within half a screen.
    @ViewBuilder func nearTop(_ changed: @escaping (Bool) -> Void) -> some View {
        if #available(iOS 18, *) {
            onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top < geometry.containerSize.height / 2
            } action: { _, near in
                changed(near)
            }
        } else {
            self
        }
    }

    /// A conversation's scrolling: opens at the newest message and follows it (`following`) as
    /// messages arrive and replies grow. Scrolling away stops following, so the text being read
    /// stays put; scrolling back to the end resumes it.
    /// `keepingPlace`: earlier messages are going in above; the message with this id stays put.
    @ViewBuilder func followsConversation(_ following: Binding<Bool>, keepingPlace: Binding<String?> = .constant(nil)) -> some View {
        if #available(iOS 18, *) {
            modifier(FollowConversation(following: following, keepingPlace: keepingPlace))
        } else {
            defaultScrollAnchor(.bottom)
        }
    }
}

/// Follows the newest message: pinned to the end until the reader scrolls up (their own input,
/// never layout), pinned again once they're back at the end. While the reader is scrolling,
/// nothing moves under them. Pinning always goes through the scroll view's own end
/// (`scrollTo(edge:)`), never a computed offset, and after the layout pass, not inside it.
@available(iOS 18, *)
private struct FollowConversation: ViewModifier {
    @Binding var following: Bool
    /// Earlier messages are going in above: keep this message where it is on screen.
    @Binding var keepingPlace: String?
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var phase = ScrollPhase.idle
    /// Not observed: updated every scrolled frame, read by the handlers.
    @State private var state = FollowState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let nearEnd: CGFloat = 32
    private var readerScrolling: Bool {
        phase == .interacting || phase == .decelerating || phase == .tracking
    }

    private struct Place: Equatable {
        var offset: CGFloat
        var content: CGFloat
        var viewport: CGFloat
        var inset: CGFloat
        var distanceToEnd: CGFloat
    }

    func body(content: Content) -> some View {
        content
            .environment(\.conversationScrolling, readerScrolling)
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: Place.self) { geometry in
                let end = geometry.contentSize.height + geometry.contentInsets.bottom - geometry.containerSize.height
                return Place(offset: geometry.contentOffset.y, content: geometry.contentSize.height,
                             viewport: geometry.containerSize.height, inset: geometry.contentInsets.bottom,
                             distanceToEnd: max(end, -geometry.contentInsets.top) - geometry.contentOffset.y)
            } action: { old, raw in
                // Geometry's offsets and insets don't always add up to the real end; where a pin
                // to the end actually lands says how far off they are. Only on a still layout: a
                // pin landing while the composer resizes (sending clears it) is short for real, and
                // taking that as the error would leave the working row hidden under the composer.
                if state.pinned, !readerScrolling, raw.content == old.content,
                   raw.viewport == old.viewport, raw.inset == old.inset {
                    state.correction = raw.distanceToEnd
                }
                state.pinned = false
                var new = raw
                new.distanceToEnd -= state.correction
                state.distanceToEnd = new.distanceToEnd
                if keepingPlace != nil, !following, new.content != old.content {
                    keepPlace()
                } else if readerScrolling, new.offset < old.offset - 0.5 {
                    // The reader moved up: stop following.
                    following = false
                } else if !following, new.offset > old.offset, new.distanceToEnd < Self.nearEnd {
                    following = true
                } else if following, !readerScrolling, abs(new.distanceToEnd) > 0.5, !state.pinPending {
                    // Grown below the view, or shrunk out from under it. Pin after this layout
                    // pass, not inside it.
                    state.pinPending = true
                    DispatchQueue.main.async {
                        state.pinPending = false
                        if following, !readerScrolling { pin(nil) }
                    }
                }
            }
            .onScrollPhaseChange { _, new in
                let wasScrolling = readerScrolling
                phase = new
                if wasScrolling, !readerScrolling { settle() }
            }
            .onChange(of: following) { _, follow in
                if follow { pin(Motion.conversation) }
            }
    }

    /// The reader stopped scrolling: resting at the end follows again; anywhere else stays put.
    private func settle() {
        let atEnd = state.distanceToEnd < Self.nearEnd
        if atEnd, following { pin(nil) }
        following = atEnd
    }

    private func keepPlace() {
        guard let id = keepingPlace else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { position.scrollTo(id: id, anchor: .top) }
    }

    private func pin(_ animation: Animation?) {
        state.pinned = animation == nil
        var transaction = Transaction(animation: animation.flatMap { Motion.reduced($0, reduceMotion) })
        transaction.disablesAnimations = animation == nil
        withTransaction(transaction) { position.scrollTo(edge: .bottom) }
    }
}

/// What the follower knows between frames, outside SwiftUI's change tracking.
@MainActor private final class FollowState {
    var distanceToEnd: CGFloat = 0
    /// How far the computed end sits from where pinning to the end really lands.
    var correction: CGFloat = 0
    /// An instant pin was just requested; the next geometry shows where it landed.
    var pinned = false
    var pinPending = false
}

/// Scrolled away from the newest messages: a round button back down to them.
struct JumpToLatest: View {
    let visible: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if visible {
                Button("Jump to latest", systemImage: "arrow.down", action: action)
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle())
                    .frosted(in: Circle())
                    .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
                    .help("Jump to latest")
                    .padding(.bottom, 10)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .animation(Motion.reduced(Motion.layout, reduceMotion), value: visible)
    }
}
