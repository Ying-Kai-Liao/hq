import KithKit
import SwiftUI

public extension View {
    /// Floating controls only (top buttons, chat box, menus): iOS 26 Liquid Glass where available, else a
    /// thin material with a white tint and edge. Content never sits in glass.
    @ViewBuilder
    func kithGlass<S: InsettableShape>(in shape: S, interactive: Bool = false) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            modifier(KithGlassFallback(shape: shape))
        }
        #else
        modifier(KithGlassFallback(shape: shape))
        #endif
    }

    /// The chat box: glass pill, 28 pt corners.
    func kithGlassPill() -> some View {
        kithGlass(in: RoundedRectangle(cornerRadius: KithRadius.glassPill, style: .continuous), interactive: true)
    }

    /// A round top button (42 pt).
    func kithGlassCircle() -> some View {
        frame(width: KithSize.topButton, height: KithSize.topButton)
            .kithGlass(in: Circle(), interactive: true)
    }
}

private struct KithGlassFallback<S: InsettableShape>: ViewModifier {
    let shape: S
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.background {
            shape.fill(.ultraThinMaterial)
                .overlay(shape.fill(Palette.glassTint))
                .overlay(shape.strokeBorder(Color.white.opacity(scheme == .dark ? 0.14 : 0.7), lineWidth: 0.5))
        }
    }
}
