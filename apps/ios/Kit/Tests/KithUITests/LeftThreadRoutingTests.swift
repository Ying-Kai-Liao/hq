import Foundation
import Testing
@testable import KithKit
@testable import KithUI

@MainActor
struct LeftThreadRoutingTests {
    @Test func leavingAThreadStartsANewTaskInThatBotsMainChatOnly() {
        let suite = "LeftThreadRouting.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let key = Data(repeating: 3, count: 32)
        let encoded = key.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let computer = Computer(id: RelayCrypto.computerId(signKey: key), name: "Mac", signKey: encoded)
        let model = BotStore(computer: computer, storage: SharedStore.Context(accountID: "t", suite: suite)) { FakeRemote(.connecting) }
        #expect(!model.startsNewTask("a", thread: nil, requested: false))
        model.leftThread.insert("a")
        #expect(model.startsNewTask("a", thread: nil, requested: false))
        // Inside an open thread a send still goes to it; another bot is unaffected.
        #expect(!model.startsNewTask("a", thread: "t1", requested: false))
        #expect(!model.startsNewTask("b", thread: nil, requested: false))
        // An explicit "New task" always wins; sending clears the flag.
        #expect(model.startsNewTask("b", thread: nil, requested: true))
        model.leftThread.remove("a")
        #expect(!model.startsNewTask("a", thread: nil, requested: false))
    }
}
