import Foundation
import Testing
@testable import CodyncKit

private func bot(_ json: String) throws -> Bot {
    try JSONDecoder().decode(Bot.self, from: Data(json.utf8))
}

@Test func aBotWorksInEveryPlaceItsHostListsAtOnce() throws {
    let b = try bot(#"{"id":"b","status":"working","workingChat":"b","workingLanes":[{"chat":"b","thread":null},{"chat":"b","thread":"root"},{"chat":"group"}]}"#)
    #expect(b.isWorking(in: "b", thread: nil))
    #expect(b.isWorking(in: "b", thread: "root"))
    #expect(b.isWorking(in: "group", thread: nil))
    #expect(!b.isWorking(in: "b", thread: "other"))
    let nowhere = try bot(#"{"id":"b","status":"working","workingChat":"b","workingLanes":[]}"#)
    #expect(!nowhere.isWorking(in: "b", thread: nil))
}

@Test func anOlderHostNamesOnePlace() throws {
    let b = try bot(#"{"id":"b","status":"working","workingThread":"root"}"#)
    #expect(b.workingLanes == nil)
    #expect(b.isWorking(in: "b", thread: "root"))
    #expect(!b.isWorking(in: "b", thread: nil))
}
