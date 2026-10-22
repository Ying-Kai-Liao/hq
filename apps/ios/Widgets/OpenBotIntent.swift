import AppIntents

/// A widget button that opens one bot's conversation. `OpenURLIntent` from a home screen
/// widget button doesn't launch the app for a custom scheme, so this intent is built into the
/// app as well and runs there (`openAppWhenRun`), handing the bot's deep link to `open`.
struct OpenBotIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Bot"
    static let isDiscoverable = false
    static let openAppWhenRun = true

    /// Set by the app at launch; the widget extension never runs `perform`.
    @MainActor static var open: (URL) -> Void = { _ in }

    @Parameter(title: "Link") var url: URL

    init() {}

    init(_ url: URL) { self.url = url }

    @MainActor func perform() async throws -> some IntentResult {
        Self.open(url)
        return .result()
    }
}
