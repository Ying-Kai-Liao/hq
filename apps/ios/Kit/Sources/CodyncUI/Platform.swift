import CodyncKit
import SwiftUI
import UIKit

enum Pasteboard {
    static func copy(_ text: String?) {
        guard let text else { return }
        UIPasteboard.general.string = text
    }
}

extension View {
    func plainTextInput() -> some View {
        textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}

extension View {
    /// Liquid Glass where the OS has it (content scrolls visibly underneath), a material before that.
    @ViewBuilder func glass(in shape: some Shape) -> some View {
        if #available(iOS 26, macOS 26, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
        }
    }
}

extension View {
    /// Grok's desktop floating surfaces (title pill, call bar): a dark frosted fill that lets the chat
    /// show through faintly, not Liquid Glass's clear lens. No border: the fill carries the edge.
    func frosted(in shape: some Shape) -> some View {
        background(Color(light: 0xF4F4F4, dark: 0x232323).opacity(0.82), in: shape)
            .background(.ultraThinMaterial, in: shape)
    }
}

extension View {
    /// The message box: Liquid Glass on iPhone; on the Mac a filled box with a
    /// soft shadow (as in Grok Bot's desktop app).
    @ViewBuilder func composerSurface(in shape: some Shape) -> some View {
        glass(in: shape)
    }

    /// Mac: Return sends, Shift-Return adds a new line. iPhone keeps Return as a new line.
    /// While an input method (Zhuyin, Pinyin, Japanese…) is composing, Return picks the candidate instead.
    @ViewBuilder func sendOnReturn(_ send: @escaping () -> Void) -> some View {
        self
    }
}

/// Compact desktop metrics while preserving the phone's touch layout and Dynamic Type.
enum InterfaceMetrics {
    static func value(mac: CGFloat, mobile: CGFloat) -> CGFloat {
        mobile
    }

    static var body: Font {
        .body
    }

    static var secondary: Font {
        .subheadline
    }
}
