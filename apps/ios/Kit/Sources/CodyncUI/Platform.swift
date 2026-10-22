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
        if #available(iOS 26, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
        }
    }
}

extension View {
    /// Floating surfaces over the chat (Jump to latest): a dark frosted fill that lets the chat
    /// show through faintly, not Liquid Glass's clear lens. No border: the fill carries the edge.
    func frosted(in shape: some Shape) -> some View {
        background(Color(light: 0xF4F4F4, dark: 0x232323).opacity(0.82), in: shape)
            .background(.ultraThinMaterial, in: shape)
    }
}
