import Foundation
import Testing
@testable import KithKit

@Suite("Incoming calls")
struct IncomingCallTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    private func event(_ state: String, id: String = "c1", remaining: Int = 30_000) -> IncomingCallEvent {
        let json = """
        {"type":"call","rev":4,"call":{"id":"\(id)","botId":"b1","threadId":null,"name":"House","reason":"the bill",
         "createdAt":1,"remainingMs":\(remaining),"state":"\(state)"}}
        """
        return IncomingCallEvent.decode(Data(json.utf8), now: now)!
    }

    @Test func aRingingCallCarriesItsOwnDeadline() {
        let e = event("ringing")
        #expect(e.ringing)
        #expect(e.call == IncomingCall(id: "c1", botId: "b1", name: "House", reason: "the bill", deadline: now.addingTimeInterval(30)))
        #expect(IncomingCallEvent.decode(Data(#"{"call":{"botId":"b"}}"#.utf8)) == nil)
        #expect(HostClient.parseEvent(Data(#"{"type":"call","call":{"id":"x","botId":"b","state":"ringing"}}"#.utf8)) != nil)
    }

    @Test func aCallShowsOnceAndAnyAnswerFromAnyDeviceTakesItAway() {
        var calls = IncomingCalls.apply([], event("ringing"))
        calls = IncomingCalls.apply(calls, event("ringing"))
        #expect(calls.count == 1, "a reconnect repeats the pending call")
        calls = IncomingCalls.apply(calls, event("ringing", id: "c2"))
        #expect(calls.map(\.id) == ["c1", "c2"])
        for state in ["accepted", "declined", "missed"] {
            #expect(IncomingCalls.apply(calls, event(state)).map(\.id) == ["c2"], "\(state)")
        }
        #expect(IncomingCalls.apply([], event("accepted")).isEmpty)
    }

    @Test func aCallWhoseRingIsOverLeavesByItself() {
        let calls = IncomingCalls.apply(IncomingCalls.apply([], event("ringing")), event("ringing", id: "c2", remaining: 5_000))
        #expect(IncomingCalls.expire(calls, now: now.addingTimeInterval(4)).count == 2)
        #expect(IncomingCalls.expire(calls, now: now.addingTimeInterval(6)).map(\.id) == ["c1"])
        #expect(IncomingCalls.expire(calls, now: now.addingTimeInterval(31)).isEmpty)
    }
}
