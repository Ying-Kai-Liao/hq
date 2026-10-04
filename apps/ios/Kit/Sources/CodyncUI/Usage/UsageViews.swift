import CodyncKit
import SwiftUI

/// Every limit as a bar under its provider, the way the menu bar lists them.
public struct UsageLimits: View {
    let usage: Usage
    @AppStorage(SharedStore.usageIconStyleKey, store: UserDefaults(suiteName: SharedStore.appGroup))
    private var usageIconStyle = UsageIconStyle.character.rawValue

    public init(usage: Usage) { self.usage = usage }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(usage.providers) { provider in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        ProviderMascot(provider, size: 18, style: UsageIconStyle(rawValue: usageIconStyle) ?? .character)
                        Text(provider.name).appFont(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                    }
                    ForEach(provider.windows) { window in
                        HStack(spacing: 10) {
                            Text(window.title).foregroundStyle(Palette.text)
                                .frame(width: 64, alignment: .leading)
                            UsageBar(percent: window.percent, tint: provider.tint)
                            Text("\(Int(window.percent.rounded()))%").monospacedDigit().foregroundStyle(Palette.text)
                                .frame(width: 36, alignment: .trailing)
                            Text(window.resetDescription ?? "").foregroundStyle(Palette.secondary)
                                .frame(width: 130, alignment: .trailing)
                        }
                        .appFont(.system(size: 12))
                        .lineLimit(1)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }
}
