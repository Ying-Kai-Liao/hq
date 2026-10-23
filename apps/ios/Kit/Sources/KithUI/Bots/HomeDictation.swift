import SwiftUI

/// Dictation for Crew's mic: the chat box's own (on-device speech into the field), usable from the app target.
@MainActor @Observable
public final class HomeDictation {
    private let inner = Dictation()
    /// The box when dictation started; the words heard go after it.
    @ObservationIgnored private var before = ""

    public init() {}

    public var listening: Bool { inner.listening }

    /// Starts listening, or stops when it already does. `heard` gets the whole new box text.
    public func toggle(current: String, heard: @escaping @MainActor (String) -> Void) {
        if inner.listening { return inner.stop() }
        before = current
        let prefix = current
        Task { await inner.start { said in heard(Dictation.join(prefix, said)) } }
    }

    public func stop() { inner.stop() }
}
