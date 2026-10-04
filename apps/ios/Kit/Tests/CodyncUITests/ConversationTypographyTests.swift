import SwiftUI
import Testing
@testable import CodyncUI

@Test func conversationTypographySanitizesImportedPreferences() throws {
    let defaultSize = ConversationTypography().pointSize
    for invalid in [Double.nan, .infinity, -.infinity] {
        #expect(ConversationTypography(pointSize: invalid).pointSize == defaultSize)
    }
    #expect(ConversationTypography(pointSize: -100).pointSize == ConversationTypography.sizes.first)
    #expect(ConversationTypography(pointSize: 100).pointSize == ConversationTypography.sizes.last)
    #expect(ConversationTypography(pointSize: 12.5).pointSize == 12.5)
}

@Test func conversationTypographyStepsThroughSizes() {
    #expect(ConversationTypography.step(12, up: true) == 13)
    #expect(ConversationTypography.step(12.5, up: true) == 13)
    #expect(ConversationTypography.step(12.5, up: false) == 12)
    #expect(ConversationTypography.step(18, up: true) == 18)
    #expect(ConversationTypography.step(11, up: false) == 11)
}

