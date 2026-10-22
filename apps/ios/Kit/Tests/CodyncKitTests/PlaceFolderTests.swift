import Foundation
import Testing
@testable import CodyncKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Test func folderObjectDecodesEveryKind() throws {
    let project = try decode(PlaceFolder.self, #"{"kind":"project","project":"hq","path":"/Users/k/hq","name":"hq","inherited":false}"#)
    #expect(project.kind == "project" && project.project == "hq" && !project.inherited && !project.missing)
    let missing = try decode(PlaceFolder.self, #"{"kind":"project","project":"x","path":null,"name":"x","inherited":true,"missing":true}"#)
    #expect(missing.path == nil && missing.inherited && missing.missing)
    let workspace = try decode(PlaceFolder.self, #"{"kind":"workspace","path":"/w","name":"Workspace","inherited":true}"#)
    #expect(workspace.icon == "tray")
}

@Test func botReadsFolderAndProjectButOlderHostsHaveNeither() throws {
    let bot = try decode(Bot.self, #"{"id":"a","name":"A","project":"hq","folder":{"kind":"project","project":"hq","path":"/p","name":"hq","inherited":true}}"#)
    #expect(bot.project == "hq" && bot.folder?.inherited == true)
    let old = try decode(Bot.self, #"{"id":"a","name":"A"}"#)
    #expect(old.project == nil && old.folder == nil)
    // A folder in a shape the app doesn't know hides the chip instead of dropping the bot.
    let odd = try decode(Bot.self, #"{"id":"a","name":"A","folder":"nonsense"}"#)
    #expect(odd.folder == nil)
}

@Test func updatingABotAlwaysSendsItsProjectSoNilClearsIt() throws {
    let bot = try decode(Bot.self, #"{"id":"a","name":"A"}"#)
    let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(BotUpdate(draft: BotDraft(bot)))) as? [String: Any])
    #expect(object["project"] is NSNull)
    var draft = BotDraft(bot)
    draft.project = "hq"
    let set = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(BotUpdate(draft: draft))) as? [String: Any])
    #expect(set["project"] as? String == "hq")
}

@Test func projectsResponseKeepsHqsErrorAndTheEmptyList() throws {
    let list = try decode(ProjectList.self, #"{"projects":[{"id":"hq","path":"/h","paths":["/h"],"parent":null,"exists":true},{"id":"gone","path":null,"paths":[],"exists":false}]}"#)
    #expect(list.projects.map(\.id) == ["hq", "gone"] && list.projects[1].exists == false && list.error == nil)
    let failed = try decode(ProjectList.self, #"{"projects":[],"error":"hq not found"}"#)
    #expect(failed.projects.isEmpty && failed.error == "hq not found")
}

@Test func listDirsResponseCarriesRootsAndProjectsButStaysReadableWithout() throws {
    let new = try decode(DirListing.self, #"""
    {"path":"/Users/k","parent":null,"isGit":false,"project":null,
     "dirs":[{"name":"hq","path":"/Users/k/hq","isGit":true,"project":"hq"},{"name":"docs","path":"/Users/k/docs","isGit":false,"project":null}],
     "roots":[{"name":"Home","path":"/Users/k"},{"name":"SSD","path":"/Volumes/SSD"}]}
    """#)
    #expect(new.parent == nil && new.roots?.map(\.name) == ["Home", "SSD"])
    #expect(new.dirs[0].project == "hq" && new.dirs[1].project == nil)
    let old = try decode(DirListing.self, #"{"path":"/a","parent":"/","isGit":true,"dirs":[{"name":"b","path":"/a/b","isGit":false}]}"#)
    #expect(old.roots == nil && old.project == nil && old.dirs[0].project == nil)
}

@Test func recentFoldersAndThreadPageDecode() throws {
    struct Res: Decodable { var folders: [RecentFolder] }
    let res = try decode(Res.self, #"{"folders":[{"path":"/p","name":"p","project":"p"},{"path":"/q","name":"q","project":null}]}"#)
    #expect(res.folders.map(\.project) == ["p", nil])
    let page = try decode(ThreadPage.self, #"{"entries":[],"folder":{"kind":"folder","path":"/q","name":"q","inherited":false}}"#)
    #expect(page.folder?.name == "q")
    let old = try decode(ThreadPage.self, #"{"entries":[]}"#)
    #expect(old.folder == nil)
}
