import Foundation

/// What the iPhone reports. Bot and message events come from the computer's host instead.
public enum AnalyticsEvent: String, Sendable {
    case appOpened = "app_opened"
    case onboardingCompleted = "onboarding_completed"
    case computerPaired = "computer_paired"
    case signedIn = "signed_in"
    case signedOut = "signed_out"
    case voiceCallStarted = "voice_call_started"
}

/// Opt-in product analytics: batches events to PostHog. Nothing is recorded until this iPhone
/// says yes. Only the app calls it; widgets and the notification extension never do.
@MainActor
public final class Analytics {
    public static let shared = Analytics()

    /// One event in PostHog's `/batch/` body.
    struct Event: Encodable, Equatable {
        let uuid = UUID()
        let event: String
        let distinct_id: String
        let timestamp: String
        let properties: [String: Value]
    }

    enum Value: Encodable, Equatable {
        case string(String), bool(Bool)

        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .string(let s): try c.encode(s)
            case .bool(let b): try c.encode(b)
            }
        }
    }

    private struct Batch: Encodable {
        let api_key: String
        let batch: [Event]
    }

    nonisolated static let endpoint = URL(string: "https://us.i.posthog.com/batch/")!
    static let apiKey = "phc_rQHvxdSFKnMquPfMjmiMhXhM4tqJ5qCYsWuVEoFxCCWX"
    /// `Bool?`: nil until asked.
    public static let enabledKey = "analyticsEnabled"
    private static let installKey = "analyticsInstallID"
    private static let identifiedKey = "analyticsIdentifiedUsers"
    private static let batchSize = 20
    private static let maxPending = 500
    private static let flushDelay = Duration.seconds(30)

    /// The signed-in Codync account, read at capture time; nil = anonymous install ID.
    public var userID: @MainActor () -> String? = { nil }
    private let defaults: UserDefaults
    private let upload: @Sendable (Data) async -> Bool
    private(set) var pending: [Event] = []
    private var timer: Task<Void, Never>?
    private var sending = false
    private var foreground = false

    init(defaults: UserDefaults = .standard, upload: @escaping @Sendable (Data) async -> Bool = Analytics.post) {
        self.defaults = defaults
        self.upload = upload
    }

    /// nil until this iPhone answers the question.
    public var isEnabled: Bool? { defaults.object(forKey: Self.enabledKey) as? Bool }

    /// Turning it off (or back to "not asked") drops everything not yet sent.
    public func setEnabled(_ enabled: Bool?) {
        defaults.set(enabled, forKey: Self.enabledKey)
        guard enabled != true else { return }
        pending = []
        timer?.cancel()
        timer = nil
    }

    public func capture(_ event: AnalyticsEvent) {
        guard isEnabled == true else { return }
        if let user = userID() {
            var identified = defaults.stringArray(forKey: Self.identifiedKey) ?? []
            if !identified.contains(user) {
                enqueue("$identify", user, ["$anon_distinct_id": .string(installID)])
                identified.append(user)
                defaults.set(identified, forKey: Self.identifiedKey)
            }
            enqueue(event.rawValue, user, [:])
        } else {
            enqueue(event.rawValue, installID, [:])
        }
    }

    /// `app_opened` once per trip to the foreground (`.inactive` blips don't count).
    public func becameActive() {
        guard !foreground else { return }
        foreground = true
        capture(.appOpened)
    }

    public func enteredBackground() {
        foreground = false
        flush()
    }

    func flush() {
        timer?.cancel()
        timer = nil
        guard !sending, !pending.isEmpty, isEnabled == true,
              let body = try? JSONEncoder().encode(Batch(api_key: Self.apiKey, batch: pending)) else { return }
        let sent = Set(pending.map(\.uuid))
        sending = true
        Task {
            let ok = await upload(body)
            sending = false
            if ok { pending.removeAll { sent.contains($0.uuid) } }
            if !pending.isEmpty { scheduleFlush() }
        }
    }

    private var installID: String {
        if let id = defaults.string(forKey: Self.installKey) { return id }
        let id = UUID().uuidString
        defaults.set(id, forKey: Self.installKey)
        return id
    }

    private func enqueue(_ name: String, _ distinctID: String, _ extra: [String: Value]) {
        var properties = Self.common.merging(extra) { $1 }
        properties["$process_person_profile"] = .bool(distinctID != installID)
        pending.append(Event(event: name, distinct_id: distinctID,
                             timestamp: Date.now.ISO8601Format(), properties: properties))
        if pending.count > Self.maxPending { pending.removeFirst(pending.count - Self.maxPending) }
        if pending.count >= Self.batchSize { flush() } else { scheduleFlush() }
    }

    private func scheduleFlush() {
        guard timer == nil else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: Self.flushDelay)
            guard !Task.isCancelled else { return }
            self?.timer = nil
            self?.flush()
        }
    }

    static let common: [String: Value] = {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        #if DEBUG
        let env = "dev"
        #else
        let env = "main"
        #endif
        return [
            "$lib": .string("codync-ios"),
            "app_version": .string(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""),
            "env": .string(env),
            "$os": .string("iOS"),
            "$os_version": .string("\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"),
            "$geoip_disable": .bool(true),
        ]
    }()

    /// Sent (or rejected for good) → true; network errors, 429 and 5xx → false, retried next flush.
    nonisolated static func post(_ body: Data) async -> Bool {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode else { return false }
        return status < 500 && status != 429
    }
}
