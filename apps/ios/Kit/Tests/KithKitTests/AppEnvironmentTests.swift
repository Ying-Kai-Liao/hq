import Foundation
import Testing
@testable import KithKit

struct AppEnvironmentTests {
    @Test func developmentWidgetsAndDataStaySeparateFromProduction() {
        #expect(AppEnvironment.main.appGroup == "group.com.yingkailiao.kith")
        #expect(AppEnvironment.main.link("computers").absoluteString == "kith://computers")
        #expect(AppEnvironment.dev.appGroup != AppEnvironment.main.appGroup)
        #expect(AppEnvironment.dev.link("computers").absoluteString == "kith-dev://computers")
        #expect(AppEnvironment.dev.link("usage").scheme != AppEnvironment.main.link("usage").scheme)
        #expect(AppEnvironment.main.accepts(scheme: "kith") && AppEnvironment.dev.accepts(scheme: "kith-dev"))
        #expect(!AppEnvironment.main.accepts(scheme: "kith-dev") && !AppEnvironment.dev.accepts(scheme: "kith"))
    }
}
