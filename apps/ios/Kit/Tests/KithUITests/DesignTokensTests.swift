import Testing
import UIKit
@testable import KithKit
@testable import KithUI

@Suite struct DesignTokensTests {
    @Test func bundledFontsRegisterAndRepeatIsHarmless() {
        KithUIFonts.register()
        KithUIFonts.register()
        for name in [KithFonts.interRegular, KithFonts.interSemiBold, KithFonts.interBold, KithFonts.nunitoExtraBold, KithFonts.jetBrainsMono] {
            #expect(KithFonts.isAvailable(name), "\(name) did not load")
        }
    }

    @Test func rampMatchesSpec() {
        #expect(KithText.agentName.size == 16 && KithText.topBar.size == 16)
        #expect(KithText.body.size == 15 && KithText.body.lineHeight == 1.45)
        #expect(KithText.secondary.size == 13 && KithText.label.size == 11 && KithText.code.size == 12)
        #expect(abs(KithText.label.tracking - 0.66) < 0.001)
    }

    @Test func skyImagesAreInTheBundle() {
        for name in ["sky-home-day", "sky-home-night", "sky-header-day", "sky-header-night"] {
            #expect(UIImage(named: name, in: KithUIFonts.resources, compatibleWith: nil) != nil, "\(name) missing")
        }
    }
}
