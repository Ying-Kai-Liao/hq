import KithKit
import SwiftUI

/// Every redesign token on one screen, for the designer and for screenshots. Debug builds open it with the
/// launch argument `-kithTokenGallery`; the previews show it in light and dark.
public struct KithTokenGallery: View {
    public init() { KithUIFonts.register() }

    private let colours: [(String, Color)] = [
        ("ink", Palette.ink), ("muted", Palette.muted), ("mutedOnSky", Palette.mutedOnSky), ("line", Palette.line),
        ("panel", Palette.panel), ("accent", Palette.accent), ("accentDark", Palette.accentDark),
        ("attention", Palette.attention), ("attentionBg", Palette.attentionBg), ("positive", Palette.positive),
        ("negative", Palette.negative), ("night", Palette.night),
        ("bubbleUser", Palette.bubbleUser), ("bubbleAgent", Palette.bubbleAgent),
    ]

    public var body: some View {
        ZStack(alignment: .top) {
            SkyBackground(.home)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("Kith tokens").kithText(.agentName).padding(.top, 54)
                    section("Colour") {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                            ForEach(colours, id: \.0) { name, colour in
                                VStack(alignment: .leading, spacing: 4) {
                                    RoundedRectangle(cornerRadius: KithRadius.rowTool)
                                        .fill(colour)
                                        .frame(height: 34)
                                        .overlay(RoundedRectangle(cornerRadius: KithRadius.rowTool).stroke(Palette.line))
                                    Text(name).kithText(.code)
                                }
                            }
                        }
                    }
                    section("Type") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("coder, Nunito 800 16").kithText(.agentName)
                            Text("Top bar, Inter 600 16").kithText(.topBar)
                            Text("Body, Inter 15 on 1.45. Every message starts something new, and old ones fold into thread rows.").kithText(.body)
                            Text("Secondary, Inter 13").kithText(.secondary).foregroundStyle(Palette.muted)
                            Text("NEEDS YOU, LABEL 11 BOLD").kithText(.label)
                            Text("let x = 12 // JetBrains Mono 12").kithText(.code)
                        }
                    }
                    section("Shape and size") {
                        HStack(spacing: 10) {
                            ForEach([("row 10", KithRadius.rowTool), ("card 18", KithRadius.card), ("pill 28", KithRadius.glassPill), ("sheet 36", KithRadius.sheet)], id: \.0) { label, radius in
                                RoundedRectangle(cornerRadius: radius, style: .continuous)
                                    .fill(Palette.panel)
                                    .frame(height: 64)
                                    .overlay(Text(label).kithText(.label))
                            }
                        }
                        HStack(spacing: 14) {
                            ForEach([KithSize.botAvatar, KithSize.botAvatarTopBar, KithSize.botAvatarThread], id: \.self) { size in
                                Circle().fill(Palette.accent).frame(width: size, height: size).kithBotShadow()
                            }
                            Text("bot 48 / 30 / 24").kithText(.secondary)
                        }
                        HStack(spacing: 8) {
                            Text("2").kithText(.label).foregroundStyle(Palette.onAccent)
                                .frame(minWidth: KithSize.countBadge, minHeight: KithSize.countBadge)
                                .background(Palette.ink, in: Capsule())
                            Text("count badge 18 (Board tab 16)").kithText(.secondary)
                        }
                    }
                    section("Glass") {
                        ZStack {
                            SkyBackground(.home, edgeToEdge: false).frame(height: 150).clipped()
                            VStack(spacing: 12) {
                                HStack(spacing: 10) {
                                    Image(systemName: "plus").frame(width: 30)
                                    Text("Tell coder…").kithText(.body).foregroundStyle(Palette.muted)
                                    Spacer()
                                    Image(systemName: "mic.fill")
                                }
                                .padding(.horizontal, 14)
                                .frame(height: KithSize.chatBoxHeight)
                                .kithGlassPill()
                                HStack(spacing: 12) {
                                    Image(systemName: "phone.fill").kithGlassCircle()
                                    Image(systemName: "ellipsis").kithGlassCircle()
                                }
                            }
                            .padding(.horizontal, KithSpacing.gutter)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: KithRadius.card, style: .continuous))
                    }
                    section("Sky") {
                        HStack(spacing: 8) {
                            ForEach([false, true], id: \.self) { night in
                                SkyBackground(.home, night: night, edgeToEdge: false).frame(height: 190).clipShape(RoundedRectangle(cornerRadius: KithRadius.card, style: .continuous))
                            }
                        }
                        ForEach([false, true], id: \.self) { night in
                            SkyBackground(.header, night: night, edgeToEdge: false).clipShape(RoundedRectangle(cornerRadius: KithRadius.card, style: .continuous))
                        }
                    }
                }
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, KithSpacing.gutter)
                .padding(.bottom, 40)
            }
            // `-kithTokenGalleryBottom` starts at the end, to screenshot the glass and sky sections.
            .defaultScrollAnchor(ProcessInfo.processInfo.arguments.contains("-kithTokenGalleryBottom") ? .bottom : .top)
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased()).kithText(.label).foregroundStyle(Palette.mutedOnSky)
            content()
        }
    }
}

#Preview("Tokens, light") { KithTokenGallery().preferredColorScheme(.light) }
#Preview("Tokens, dark") { KithTokenGallery().preferredColorScheme(.dark) }
