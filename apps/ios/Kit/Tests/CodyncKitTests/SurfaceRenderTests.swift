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
