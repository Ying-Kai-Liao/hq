import Foundation
import Testing
@testable import CodyncKit
@testable import CodyncUI

private func bot(_ json: String) throws -> Bot { try JSONDecoder().decode(Bot.self, from: Data(json.utf8)) }

private let installed = [("pdf", "PDF"), ("code-review", "Code Review"), ("xlsx", "xlsx")].map {
    InstalledSkill(id: $0.0, name: $0.1, description: "", source: "custom", path: "")
}

@Test func aLeadingSlashOpensTheListUntilTheNameEnds() {
    #expect(SlashCommands.query("/") == "")
    #expect(SlashCommands.query("/pd") == "pd")
    #expect(SlashCommands.query("/pdf merge") == nil)
    #expect(SlashCommands.query("hi /pdf") == nil)
}

@Test func builtInCommandsComeFirstThenOnlyTheBotsOwnSkills() throws {
    let offered = try bot(#"{"id":"b","skills":["pdf","code-review"],"fastModeSupport":"offered"}"#)
    #expect(SlashCommands.list(for: offered, query: "", skills: installed).map(\.name) == ["fast", "new", "pdf", "code-review"])
    #expect(SlashCommands.list(for: offered, query: "review", skills: installed).map(\.name) == ["code-review"])
    #expect(SlashCommands.list(for: offered, query: "session", skills: installed).map(\.name) == ["new"])
    #expect(SlashCommands.list(for: try bot(#"{"id":"b","skills":["pdf"]}"#), query: "xl", skills: installed).isEmpty)
    #expect(SlashCommands.list(for: try bot(#"{"id":"b"}"#), query: "", skills: []).map(\.name) == ["fast", "new"], "offered until the agent says otherwise")
    #expect(SlashCommands.list(for: try bot(#"{"id":"b","fastModeSupport":"unsupported"}"#), query: "", skills: []).map(\.name) == ["new"], "no Fast mode on offer")
    #expect(SlashCommands.list(for: try bot(#"{"id":"g","kind":"group","fastModeSupport":"offered"}"#), query: "", skills: installed).isEmpty)
}

@Test func sendingJustABuiltInCommandRunsIt() throws {
    let offered = try bot(#"{"id":"b","fastModeSupport":"offered"}"#)
    #expect(SlashCommands.builtIn(for: offered, draft: "/fast ")?.action == .fast)
    #expect(SlashCommands.builtIn(for: offered, draft: "/new")?.action == .newSession)
    #expect(SlashCommands.builtIn(for: offered, draft: "/fast please") == nil)
    #expect(SlashCommands.builtIn(for: try bot(#"{"id":"b","fastModeSupport":"unsupported"}"#), draft: "/fast") == nil, "without Fast mode it reaches the agent")
}
