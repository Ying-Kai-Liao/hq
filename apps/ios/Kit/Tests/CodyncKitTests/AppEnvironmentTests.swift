import Foundation
import Testing
@testable import CodyncKit

struct AppEnvironmentTests {
    @Test func developmentWidgetsAndDataStaySeparateFromProduction() {
        #expect(AppEnvironment.main.appGroup == "group.com.yingkailiao.kith")
        #expect(AppEnvironment.main.link("computers").absoluteString == "kith://computers")
        #expect(AppEnvironment.dev.appGroup != AppEnvironment.main.appGroup)
        #expect(AppEnvironment.dev.link("computers").absoluteString == "kith-dev://computers")
        #expect(AppEnvironment.dev.link("usage").scheme != AppEnvironment.main.link("usage").scheme)
        #expect(AppEnvironment.main.accepts(scheme: "codync") && AppEnvironment.dev.accepts(scheme: "codync-dev"))
        #expect(!AppEnvironment.main.accepts(scheme: "codync-dev") && !AppEnvironment.dev.accepts(scheme: "kith"))
    }
}
