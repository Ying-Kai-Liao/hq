import Foundation
import SwiftUI
import Testing
@testable import CodyncKit

/// Renders the Live Activity, Dynamic Island and widget cards to PNG contact sheets for design
/// review (the simulator's screenshots don't show Live Activities). Runs only when asked:
/// `TEST_RUNNER_CODYNC_RENDER_DIR=<dir> xcodebuild test … -only-testing:CodyncKitTests/renderSurfaces`
@MainActor @Test func renderSurfaces() throws {
    guard let dir = ProcessInfo.processInfo.environment["CODYNC_RENDER_DIR"] else { return }
    let bot = Bot.widgetPreview[0]
    let started = Date.now - 154
    let phases: [(String, BotActivityPresentation)] = [
        ("Sending", .init(status: "sending", activity: "")),
        ("Waiting for computer", .init(status: "queued", activity: "")),
        ("Working", .init(status: "working", activity: "Running the test suite.")),
        ("Needs you", .init(status: "needsInput", activity: "Review the proposed changes.")),
        ("Done", .init(status: "idle", activity: "")),
        ("Failed", .init(status: "error", activity: "")),
        ("Update delayed", .init(status: "working", activity: "", isStale: true)),
    ]

    func label(_ text: String) -> some View {
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.secondary)
    }

    for scheme in [ColorScheme.light, .dark] {
        let activities = VStack(alignment: .leading, spacing: 28) {
            ForEach(phases, id: \.0) { name, state in
                VStack(alignment: .leading, spacing: 10) {
                    label(name)
                    HStack(alignment: .top, spacing: 20) {
                        BotActivityPreview(bot: bot, state: state, form: .lockScreen, startedAt: started).frame(width: 360)
                        VStack(spacing: 10) {
                            BotActivityPreview(bot: bot, state: state, form: .compact, startedAt: started)
                            BotActivityPreview(bot: bot, state: state, form: .minimal, startedAt: started)
                        }
                        BotActivityPreview(bot: bot, state: state, form: .expanded, startedAt: started).frame(width: 370)
                    }
                }
            }
        }
        try save(activities, scheme: scheme, to: "\(dir)/activity-\(scheme == .dark ? "dark" : "light").png")

        let widgets = HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                label("Team")
                BotsTeamCard(bots: Bot.widgetPreview).padding(14).frame(width: 170, height: 170)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22))
            }
            VStack(alignment: .leading, spacing: 8) {
                label("Bots · Small")
                BotsWidgetCard(bots: Bot.widgetPreview, wide: false).padding(14).frame(width: 170, height: 170)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22))
            }
            VStack(alignment: .leading, spacing: 8) {
                label("Bots · Medium")
                BotsWidgetCard(bots: Bot.widgetPreview, wide: true).padding(14).frame(width: 364, height: 170)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 22))
            }
        }
        try save(widgets, scheme: scheme, to: "\(dir)/widgets-\(scheme == .dark ? "dark" : "light").png")
    }
}

@MainActor private func save(_ view: some View, scheme: ColorScheme, to path: String) throws {
    let renderer = ImageRenderer(content: view.padding(28).background(Palette.background).environment(\.colorScheme, scheme))
    renderer.scale = 2
    let data = try #require(renderer.uiImage?.pngData())
    try data.write(to: URL(fileURLWithPath: path))
}

/// A still frame of the bot carries its state: a working bot's eyes sit lower than an idle one's,
/// an errored bot slumps and droops, and Reduce Motion centres the eyes whatever the state.
@MainActor @Test func theStillBotPosesItsEyesPerState() throws {
    func frame(_ mood: CharacterAvatar.Mood, reduced: Bool = false) throws -> [UInt8] {
        let view = StillBot(asset: "crew-builder", paletteId: nil, size: 64, mood: mood, reduced: reduced).environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        let cg = try #require(renderer.cgImage)
        var px = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        px.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        }
        return px
    }
    let idle = try frame(.idle), working = try frame(.working), error = try frame(.error)
    #expect(idle != working)
    #expect(idle != error)
    #expect(try frame(.working, reduced: true) == idle)
    #expect(try frame(.error, reduced: true) == idle)
}

// MARK: - The hop glyph fonts

/// Registers the committed KithHop fonts, as the widget extension's UIAppFonts does.
private func registerHopFonts() {
    let fonts = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Widgets/Resources/Fonts")
    for name in ["KithHop-Dot", "KithHop-Ghost"] {
        CTFontManagerRegisterFontsForURL(fonts.appendingPathComponent("\(name).ttf") as CFURL, .process, nil)
    }
}

@MainActor private func hopPixels(_ content: Text, size: CGFloat = 64) throws -> [UInt8] {
    let view = HopFrames(content, color: .white, size: size).background(Color.black).environment(\.colorScheme, .dark)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 1
    let cg = try #require(renderer.cgImage)
    var px = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
    px.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
    }
    return px
}

/// The fonts map each digit to a pose and draw only the timer's last digit, so a timer steps
/// through the hop one pose a second whatever its length.
@MainActor @Test func theHopFontsDrawOneStepPerSecond() throws {
    registerHopFonts()
    let poses = try (0...9).map { try hopPixels(Text("\($0)")) }
    // Every digit draws a lit body on the black ground, and no two poses are the same picture.
    for pose in poses { #expect(pose.enumerated().filter { $0.offset % 4 == 0 && $0.element > 200 }.count > 200) }
    #expect(Set(poses).count >= 8)  // rest and settle frames can coincide at this size
    // Only the last character shows: "10:07" is the pose of "7".
    #expect(try hopPixels(Text("10:07")) == poses[7])
    #expect(try hopPixels(Text("0:59")) == poses[9])
}

/// Writes the hop's ten poses on the Dynamic Island's black, for design review:
/// `TEST_RUNNER_CODYNC_RENDER_DIR=<dir> xcodebuild test … -only-testing:CodyncKitTests/renderHop`.
@MainActor @Test func renderHop() throws {
    guard let dir = ProcessInfo.processInfo.environment["CODYNC_RENDER_DIR"] else { return }
    registerHopFonts()
    let blue = Color(red: 0.36, green: 0.55, blue: 1)
    let sheet = HStack(spacing: 18) {
        ForEach(0..<10, id: \.self) { digit in
            VStack(spacing: 8) {
                HopFrames(Text("\(digit)"), color: blue, size: 56)
                HopFrames(Text("\(digit)"), color: blue, size: 20)
            }
        }
    }
    .padding(24).background(Color.black)
    let renderer = ImageRenderer(content: sheet)
    renderer.scale = 2
    try #require(renderer.uiImage?.pngData()).write(to: URL(fileURLWithPath: "\(dir)/hop-poses.png"))
}
