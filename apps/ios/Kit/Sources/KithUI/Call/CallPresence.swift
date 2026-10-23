import Foundation

/// How many call screens are up. An agent that rings during a call is turned away as busy: the ring would
/// otherwise take the audio session from the live call.
@MainActor
enum CallPresence {
    static var active = 0
}
