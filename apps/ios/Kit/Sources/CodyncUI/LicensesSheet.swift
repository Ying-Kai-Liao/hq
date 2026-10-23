import CodyncKit
import SwiftUI

/// Settings' "Open-source licenses" row: the attribution Apache-2.0 asks for, and the one place
/// the upstream project is named.
public struct LicensesSheet: View {
    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            ModalHeader("Open-source licenses")
            CardForm {
                CardSection {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Codync")
                        Text("Kith began as a fork of Codync by leepokai, used under the Apache License 2.0.")
                            .font(.footnote)
                            .foregroundStyle(Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let url = URL(string: "https://github.com/leepokai/Codync") {
                        Link("Codync on GitHub", destination: url)
                            .foregroundStyle(Palette.text)
                    }
                }
            }
        }
        .background(Palette.background)
    }
}
