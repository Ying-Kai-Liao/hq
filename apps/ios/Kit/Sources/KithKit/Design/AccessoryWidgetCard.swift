import SwiftUI
import WidgetKit

/// Monochrome Lock Screen widgets; the system supplies the background and tint. No bots here:
/// figures and words only, in the accent the Lock Screen applies.
public struct AccessoryWidgetCard: View {
    public enum Kind { case bots, usage }
    public enum Family: String, CaseIterable { case circular = "Circle", rectangular = "Rectangle", inline = "Inline" }
    let kind: Kind
    let family: Family
    let bots: [Bot]
    let usage: Usage
    let paired: Bool

    public init(kind: Kind, family: Family, bots: [Bot] = [], usage: Usage = Usage(), paired: Bool = true) {
        self.kind = kind; self.family = family; self.bots = bots.filter { !$0.hidden }
        self.usage = usage; self.paired = paired
    }

    private var needs: Int { bots.filter(\.needsInput).count }
    private var working: Int { bots.filter { $0.isWorking && !$0.needsInput }.count }
    private var count: Int { needs > 0 ? needs : working > 0 ? working : bots.count }
    private var botLabel: String { needs > 0 ? (needs == 1 ? "needs you" : "need you") : working > 0 ? "working" : (bots.count == 1 ? "bot" : "bots") }
    private var top: (name: String, window: UsageWindow)? {
        usage.providers.flatMap { p in p.windows.map { (name: p.name, window: $0) } }
            .max { $0.window.percent < $1.window.percent }
    }
    private var headline: String {
        guard paired else { return "Connect a computer" }
        if kind == .bots { return bots.isEmpty ? "No bots yet" : "\(count) \(botLabel)" }
        return top.map { "\($0.name) \(Int($0.window.percent.rounded()))%" } ?? "No usage yet"
    }

    /// "2 need you · 2 working"
    private var inlineText: String {
        guard kind == .bots, paired, !bots.isEmpty else { return headline }
        var parts: [String] = []
        if needs > 0 { parts.append("\(needs) \(needs == 1 ? "needs" : "need") you") }
        if working > 0 { parts.append("\(working) working") }
        return parts.isEmpty ? headline : parts.joined(separator: " · ")
    }

    /// The window's first word with a percent sign: "Opus %".
    private func usageCaption(_ title: String) -> String { "\(title.split(separator: " ").first.map(String.init) ?? title) %" }

    public var body: some View {
        Group {
            switch family {
            case .inline:
                Label(inlineText, systemImage: kind == .bots ? "message" : "chart.bar")
                    .font(.caption).lineLimit(1)
            case .circular:
                if !paired {
                    Image(systemName: "desktopcomputer").accessibilityLabel(headline)
                } else {
                    VStack(spacing: 0) {
                        Text(kind == .bots ? "\(count)" : top.map { "\(Int($0.window.percent.rounded()))" } ?? "—")
                            .font(WidgetStyle.mono(24))
                        Text(kind == .bots ? (needs > 0 ? "need you" : working > 0 ? "working" : "bots") : top.map { usageCaption($0.window.title) } ?? "usage")
                            .font(WidgetStyle.label(9.5))
                    }
                    .minimumScaleFactor(0.7)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(headline)
                }
            case .rectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind == .bots ? "Bots" : "Usage limits").font(WidgetStyle.label(12, .bold)).lineLimit(1)
                    if !paired {
                        Text("Connect a computer").font(WidgetStyle.label(11)).lineLimit(1)
                    } else if kind == .bots {
                        if bots.isEmpty { Text("No bots yet").font(WidgetStyle.label(11)).lineLimit(1) }
                        ForEach(bots.sorted { rank($0) < rank($1) }.prefix(2)) { bot in
                            Text("\(bot.name) · \(bot.needsInput ? "Needs you" : bot.isWorking ? "Working" : "Ready")")
                                .font(WidgetStyle.label(11)).lineLimit(1)
                        }
                    } else if let top {
                        Text("\(top.window.title) \(Int(top.window.percent.rounded()))%").font(WidgetStyle.label(11)).lineLimit(1)
                        if let reset = top.window.resetsShort() {
                            Text(reset).font(WidgetStyle.label(11)).lineLimit(1)
                        }
                    } else {
                        Text("No usage yet").font(WidgetStyle.label(11)).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .widgetAccentable()
        .accessibilityElement(children: .combine)
    }

    private func rank(_ bot: Bot) -> Int { bot.needsInput ? 0 : bot.isWorking ? 1 : 2 }
}
