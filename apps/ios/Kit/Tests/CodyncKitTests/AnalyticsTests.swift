import Foundation
import Testing
@testable import CodyncKit

@MainActor
@Test func analyticsIsOffAndCannotBeTurnedOn() {
    let analytics = Analytics()
    #expect(!analytics.isEnabled)
    analytics.setEnabled(true)
    #expect(!analytics.isEnabled)
    analytics.capture(.appOpened)
    analytics.record("$exception", [:])
}

@MainActor
@Test func crashReportsSendNamesAndFramesButNoMessage() throws {
    // MetricKit's call-stack JSON: the root frame crashed, each first sub-frame is its caller.
    func frame(_ binary: String, _ offset: Int, _ caller: String = "") -> String {
        #"{"binaryName":"\#(binary)","offsetIntoBinaryTextSegment":\#(offset),"binaryUUID":"U","address":1,"sampleCount":1\#(caller.isEmpty ? "" : #","subFrames":[\#(caller)]"#)}"#
    }
    let crashed = frame("CodyncKit", 3, frame("SwiftUI", 2, frame("Codync", 1)))
    let json = #"{"callStackPerThread":true,"callStacks":[{"threadAttributed":false,"callStackRootFrames":[\#(frame("libsystem_kernel.dylib", 9))]},{"threadAttributed":true,"callStackRootFrames":[\#(crashed)]}]}"#
    let p = CrashReports.properties(callStack: Data(json.utf8), exceptionType: 1, signal: 11, appVersion: "2.14.1")

    #expect(p["$exception_level"] == .string("fatal"))
    #expect(p["process"] == .string("ios"))
    #expect(p["app_version"] == .string("2.14.1"))
    guard case .array(let list) = p["$exception_list"], case .object(let exception) = list.first,
          case .object(let stack) = exception["stacktrace"], case .array(let frames) = stack["frames"] else {
        Issue.record("no exception")
        return
    }
    #expect(exception["type"] == .string("EXC_BAD_ACCESS"))
    #expect(exception["value"] == .string("SIGSEGV"))
    // The attributed thread, oldest first: the crashing frame is last.
    let functions = frames.compactMap { if case .object(let f) = $0 { f["function"] } else { nil } }
    #expect(functions == [.string("Codync + 1"), .string("SwiftUI + 2"), .string("CodyncKit + 3")])
    let inApp = frames.compactMap { if case .object(let f) = $0 { f["in_app"] } else { nil } }
    #expect(inApp == [.bool(true), .bool(false), .bool(true)])

    // Unknown numbers fall back to generic names; nothing but names and offsets is sent.
    let unknown = CrashReports.properties(callStack: Data("{}".utf8), exceptionType: 99, signal: nil, appVersion: "1")
    let encoded = String(decoding: try JSONEncoder().encode(unknown), as: UTF8.self)
    #expect(encoded.contains(#""type":"Crash""#) && encoded.contains(#""frames":[]"#))

    // A runaway stack keeps the 200 frames nearest the crash.
    var deep = frame("Codync", 0)
    for i in 1...250 { deep = frame("Codync", i, deep) }
    let capped = CrashReports.frames(Data(#"{"callStacks":[{"callStackRootFrames":[\#(deep)]}]}"#.utf8))
    #expect(capped.count == 200)
    #expect(capped.last == .object(["platform": .string("custom"), "lang": .string("swift"), "function": .string("Codync + 250"),
                                    "module": .string("Codync"), "resolved": .bool(false), "in_app": .bool(true)]))
}
