import Foundation
import Testing
@testable import KithKit

@Test func kithVariablesWinOverThePlist() {
    let env = ["KITH_CLERK_PUBLISHABLE_KEY": "pk_live_kith", "KITH_CLOUD_URL": "https://kith.example"]
    let kith = AccountConfig.resolve(env: env, cloudURL: "https://file.example", clerkPublishableKey: "pk_test_file")
    #expect(kith.clerkPublishableKey == "pk_live_kith")
    #expect(kith.cloudURL == URL(string: "https://kith.example"))
    let file = AccountConfig.resolve(env: [:], cloudURL: "https://file.example", clerkPublishableKey: "pk_test_file")
    #expect(file.clerkPublishableKey == "pk_test_file")
    #expect(file.cloudURL == URL(string: "https://file.example"))
}

@Test func emptyOrMalformedConfigurationMeansAccountsAreOff() {
    let empty = AccountConfig.resolve(env: ["KITH_CLERK_PUBLISHABLE_KEY": "  ", "KITH_CLOUD_URL": ""], cloudURL: "", clerkPublishableKey: "")
    #expect(empty.clerkPublishableKey == nil)
    #expect(empty.cloudURL == nil)
    let bad = AccountConfig.resolve(env: ["KITH_CLERK_PUBLISHABLE_KEY": "sk_live_x", "KITH_CLOUD_URL": "ftp://x.example"], cloudURL: nil, clerkPublishableKey: nil)
    #expect(bad.clerkPublishableKey == nil)
    #expect(bad.cloudURL == nil)
}

@Test func theOAuthReturnFallsBackToTheKithScheme() {
    #expect(AccountConfig.fallbackScheme(environment: "dev") == "kith-dev")
    #expect(AccountConfig.fallbackScheme(environment: "main") == "kith")
    #expect(AccountConfig.fallbackScheme(environment: nil) == "kith")
}

@Test func aLinkCodeDecodesWithItsExpiry() throws {
    let code = try JSONDecoder().decode(LinkCode.self, from: Data(#"{"code":"123456","expiresAt":1760000000000}"#.utf8))
    #expect(code.code == "123456")
    #expect(code.expiry == Date(timeIntervalSince1970: 1_760_000_000))
}
