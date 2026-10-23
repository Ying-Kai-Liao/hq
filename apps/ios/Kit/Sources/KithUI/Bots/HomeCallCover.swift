import KithKit
import SwiftUI

/// The voice call, for Crew's call button: the same full-screen call a chat starts, without opening the chat first.
public struct HomeCallCover: View {
    let store: BotStore
    let botId: String
    let close: () -> Void

    public init(store: BotStore, botId: String, close: @escaping () -> Void) {
        self.store = store
        self.botId = botId
        self.close = close
    }

    /// Why a call can't start now; nil when it can (the same rules as the chat's phone button).
    @MainActor public static func block(store: BotStore, botId: String) -> String? {
        if store.bots[botId] == nil { return "This chat is no longer available." }
        if store.isOffline { return "\(store.hostName) is offline." }
        if store.mismatch != nil { return "Update Kith to make calls." }
        return nil
    }

    public var body: some View {
        CallScreen(botId: botId, close: close).environment(store)
    }
}
