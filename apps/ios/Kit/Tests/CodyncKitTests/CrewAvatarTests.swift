import Foundation
import Testing
@testable import CodyncKit

@Test func autoShowsTheMatchingCrewPortraitElseTheHammerBot() {
    #expect(CrewAvatar.asset(source: "auto", id: "b1", name: "House", isGroup: false) == "crew-house")
    #expect(CrewAvatar.asset(source: "auto", id: "hq-sound", name: "Helper", isGroup: false) == "crew-sound")
    #expect(CrewAvatar.asset(source: "auto", id: "b2", name: "seo", isGroup: false) == "crew-builder")
}

@Test func aHostWithoutAvatarSourceMeansAuto() throws {
    let bot = try JSONDecoder().decode(Bot.self, from: Data(#"{"id":"b","name":"Sam"}"#.utf8))
    #expect(bot.avatarSource == "auto")
    #expect(CrewAvatar.asset(for: bot) == "crew-builder")
}

@Test func anExplicitImageWinsAndShapeDrawsTheCharacter() {
    #expect(CrewAvatar.asset(source: "crew:video", id: "b", name: "house", isGroup: false) == "crew-video")
    #expect(CrewAvatar.asset(source: "spare:gradcap", id: "b", name: "Sam", isGroup: false) == "spare-gradcap")
    #expect(CrewAvatar.asset(source: "shape", id: "b", name: "house", isGroup: false) == nil)
}

@Test func groupsKeepTheirOwnAvatarAndUnknownImagesFallBackToAuto() {
    #expect(CrewAvatar.asset(source: "auto", id: "g", name: "Room", isGroup: true) == nil)
    #expect(CrewAvatar.asset(source: "spare:nope", id: "b", name: "Sam", isGroup: false) == "crew-builder")
    #expect(CrewAvatar.asset(source: "future:thing", id: "b", name: "Sam", isGroup: false) == "crew-builder")
}
