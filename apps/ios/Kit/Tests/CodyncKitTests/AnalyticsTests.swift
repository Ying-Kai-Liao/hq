import Foundation
import Testing
@testable import CodyncKit

@MainActor
@Test func analyticsRecordsOnlyWhenEnabledAndIdentifiesAccountsOnce() throws {
    let defaults = try #require(UserDefaults(suiteName: "AnalyticsTests-\(UUID())"))
    let analytics = Analytics(defaults: defaults) { _ in false }

    // Not asked yet, then declined: nothing recorded.
    analytics.capture(.appOpened)
    analytics.setEnabled(false)
    analytics.capture(.appOpened)
    #expect(analytics.pending.isEmpty)

    // Anonymous: the install ID, no person profile, the common properties.
    analytics.setEnabled(true)
    analytics.capture(.computerPaired)
    let anon = try #require(analytics.pending.first)
    #expect(anon.event == "computer_paired")
    #expect(anon.properties["$process_person_profile"] == .bool(false))
    #expect(anon.properties["$lib"] == .string("codync-ios"))
    #expect(anon.properties["$os"] == .string("iOS"))
    #expect(anon.properties["$geoip_disable"] == .bool(true))
    #expect(anon.properties["env"] != nil && anon.properties["app_version"] != nil)

    // Signed in: $identify links the install ID once, then events carry the user ID.
    analytics.userID = { "user_1" }
    analytics.capture(.signedIn)
    analytics.capture(.voiceCallStarted)
    let names = analytics.pending.map(\.event)
    #expect(names == ["computer_paired", "$identify", "signed_in", "voice_call_started"])
    let identify = analytics.pending[1]
    #expect(identify.distinct_id == "user_1")
    #expect(identify.properties["$anon_distinct_id"] == .string(anon.distinct_id))
    #expect(analytics.pending[2].properties["$process_person_profile"] == .bool(true))

    // Turning it off drops what wasn't sent.
    analytics.setEnabled(false)
    #expect(analytics.pending.isEmpty)
}
