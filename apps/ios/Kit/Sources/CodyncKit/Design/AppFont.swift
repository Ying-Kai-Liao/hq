import SwiftUI

/// Keeps each font's hierarchy and styling while applying the Mac text preference.
public struct AppFont: Sendable {
    private var original: Font
    private var pointSize: CGFloat
    private var fontWeight: Font.Weight
    private var design: Font.Design
    private var automaticBoldWeight: Font.Weight = .bold
    private var hasMonospacedDigits = false

    private init(_ original: Font, size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) {
        self.original = original
        pointSize = size
        fontWeight = weight
        self.design = design
    }

    public static var largeTitle: Self { semantic(.largeTitle) }
    public static var title: Self { semantic(.title) }
    public static var title2: Self { semantic(.title2) }
    public static var title3: Self { semantic(.title3) }
    public static var headline: Self { semantic(.headline) }
    public static var subheadline: Self { semantic(.subheadline) }
    public static var body: Self { semantic(.body) }
    public static var callout: Self { semantic(.callout) }
    public static var footnote: Self { semantic(.footnote) }
    public static var caption: Self { semantic(.caption) }
    public static var caption2: Self { semantic(.caption2) }

    /// Codync's existing compact desktop fonts; phones retain their semantic fonts.
    public static var compactBody: Self {
        body
    }

    public static var compactSecondary: Self {
        subheadline
    }

    public static func system(size: CGFloat, weight: Font.Weight? = nil, design: Font.Design? = nil) -> Self {
        Self(.system(size: size, weight: weight, design: design), size: size, weight: weight ?? .regular, design: design ?? .default)
    }

    public static func system(_ style: Font.TextStyle, design: Font.Design? = nil) -> Self {
        var font = semantic(style)
        font.original = .system(style, design: design)
        font.design = design ?? .default
        return font
    }

    public func weight(_ weight: Font.Weight) -> Self {
        var font = self
        font.original = original.weight(weight)
        font.fontWeight = weight
        return font
    }

    public func bold() -> Self {
        var font = self
        font.original = original.bold()
        font.fontWeight = automaticBoldWeight
        return font
    }

    public func monospaced() -> Self {
        var font = self
        font.original = original.monospaced()
        font.design = .monospaced
        return font
    }

    public func monospacedDigit() -> Self {
        var font = self
        font.original = original.monospacedDigit()
        font.hasMonospacedDigits = true
        return font
    }

    func scaled(by scale: CGFloat) -> Font {
        return original
    }

    /// macOS 14–15 lack Font.scaled(by:); recreate the native font with its traits.
    func fallbackScaled(by scale: CGFloat) -> Font {
        let font = Font.system(size: pointSize * scale, weight: fontWeight, design: design)
        return hasMonospacedDigits ? font.monospacedDigit() : font
    }

    private static func semantic(_ style: Font.TextStyle) -> Self {
        let size: CGFloat = 0 // Only used by the Mac fallback.
        var font = Self(.system(style), size: size, weight: style == .headline ? .bold : .regular)
        // Native .bold() uses semibold for small semantic text and bold for
        // titles/headlines. An explicit .weight(.bold) remains explicit bold.
        switch style {
        case .largeTitle, .title, .title2, .title3, .headline: font.automaticBoldWeight = .bold
        default: font.automaticBoldWeight = .semibold
        }
        return font
    }
}

private struct AppFontScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1
}

public extension EnvironmentValues {
    var appFontScale: CGFloat {
        get { self[AppFontScaleKey.self] }
        set { self[AppFontScaleKey.self] = newValue }
    }
}

private struct AppFontModifier: ViewModifier {
    let font: AppFont
    @Environment(\.appFontScale) private var scale

    func body(content: Content) -> some View {
        content.font(font.scaled(by: scale))
    }
}

public extension View {
    func appFont(_ font: AppFont) -> some View {
        modifier(AppFontModifier(font: font))
    }
}
