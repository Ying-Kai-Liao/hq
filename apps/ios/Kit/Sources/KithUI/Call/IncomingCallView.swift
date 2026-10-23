import KithKit
import SwiftUI

/// An agent is calling: full screen with its face, name and why, Accept and Decline. It rings (and vibrates) while
/// it is up. There is no push, so it appears only in an open app; any device that answers, or the timeout, takes it
/// away from the others.
public struct IncomingCallView: View {
    let call: IncomingCall
    let bot: Bot?
    let accept: () -> Void
    let decline: () -> Void
    @State private var ring = RingTone()
    @State private var accepting = false

    public init(call: IncomingCall, bot: Bot?, accept: @escaping () -> Void, decline: @escaping () -> Void) {
        self.call = call
        self.bot = bot
        self.accept = accept
        self.decline = decline
    }

    private var name: String { bot?.name ?? call.name }

    public var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            if let bot { CharacterAvatar(bot: bot, size: 168) }
            VStack(spacing: 6) {
                Text(name)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Palette.text)
                Text("is calling")
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                if !call.reason.isEmpty {
                    Text(call.reason)
                        .font(.body)
                        .foregroundStyle(Palette.text)
                        .multilineTextAlignment(.center)
                        .padding(.top, 10)
                }
            }
            .padding(.top, 18)
            .padding(.horizontal, 20)
            Spacer()
            HStack(spacing: 72) {
                button("Decline", "phone.down.fill", Palette.danger, action: decline)
                button("Accept", "phone.fill", Palette.positive) {
                    guard !accepting else { return }
                    accepting = true
                    // The call's own audio session takes over from the ring.
                    ring.stop()
                    accept()
                }
            }
            .padding(.bottom, 48)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background.ignoresSafeArea())
        .onAppear { ring.start() }
        .onDisappear { ring.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(name) is calling")
    }

    private func button(_ label: String, _ symbol: String, _ fill: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 68, height: 68)
                .background(fill, in: Circle())
        }
        .buttonStyle(PressScale())
        .accessibilityLabel(label)
    }
}
