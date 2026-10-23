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

/// Writes the Dynamic Island's working loop (the thinking orb, 10 frames, in points of a 20 pt
/// face) for tools/timer-fonts.py:
/// `TEST_RUNNER_CODYNC_FRAMES_FILE=<file.json> xcodebuild test … -only-testing:'CodyncKitTests/exportBotFrames()'`.
/// Each font is one layer: `Ghost` the orb's faint orbit trails, `Dot` its moving dots.
@MainActor @Test func exportBotFrames() throws {
    guard let file = ProcessInfo.processInfo.environment["CODYNC_FRAMES_FILE"] else { return }
    func dots(_ list: [(x: Double, y: Double, r: Double)]) -> [[String: Double]] {
        list.map { ["x": $0.x, "y": $0.y, "r": $0.r] }
    }
    var fonts: [String: [[[String: Double]]]] = [:]
    let orb = ThinkingOrbGeometry.workingLoop(size: 20)
    fonts["CodyncOrb-Ghost"] = orb.map { f in dots(f.dots.filter { $0.alpha < 1 }.map { ($0.x, $0.y, $0.radius) }) }
    fonts["CodyncOrb-Dot"] = orb.map { f in dots(f.dots.filter { $0.alpha >= 1 }.map { ($0.x, $0.y, $0.radius) }) }
    let data = try JSONSerialization.data(withJSONObject: ["size": 20, "fonts": fonts], options: [.sortedKeys])
    try data.write(to: URL(fileURLWithPath: file))
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
