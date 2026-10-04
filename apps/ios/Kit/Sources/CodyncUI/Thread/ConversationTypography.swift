import SwiftUI

/// The Mac preference supplies one scale for conversation text and app chrome.
public struct ConversationTypography: Sendable {
    public static let preferenceKey = "conversationFontSize"
    public static let defaultSize = 12.0
    public static let sizes: [Double] = [11, 12, 13, 14, 15, 16, 18]

    public let pointSize: Double

    /// The next larger (`up`) or smaller size in `sizes` for ⌘+ / ⌘−, staying at either end.
    public static func step(_ size: Double, up: Bool) -> Double {
        (up ? sizes.first { $0 > size } : sizes.last { $0 < size }) ?? size
    }

    public init(pointSize: Double = ConversationTypography.defaultSize) {
        self.pointSize = pointSize.isFinite ? min(max(pointSize, 11), 18) : Self.defaultSize
    }

    public var scale: CGFloat {
        1
    }

    var body: Font {
        .body
    }

    func heading(level: Int) -> Font {
        level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold()
    }

    var code: Font {
        .system(.footnote, design: .monospaced)
    }
}

private struct ConversationTypographyKey: EnvironmentKey {
    static let defaultValue = ConversationTypography()
}

public extension EnvironmentValues {
    var conversationTypography: ConversationTypography {
        get { self[ConversationTypographyKey.self] }
        set { self[ConversationTypographyKey.self] = newValue }
    }
}
