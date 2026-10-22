import Testing
@testable import CodyncUI

@Test func memoryFileSplitsAtBlankLinesButNotInsideCodeFences() {
    let chunks = KithMemoryChunks.split("# A\ntext\n\n```\ncode\n\nmore\n```\n\nlast")
    #expect(chunks.map(\.line) == [1, 4, 10])
    #expect(chunks[1].text.contains("more"))
    #expect(KithMemoryChunks.index(of: 6, in: chunks) == 1)
    #expect(KithMemoryChunks.index(of: 1, in: chunks) == 0)
}

@Test func aHugeUnbrokenFileStillSplits() {
    let text = (1...450).map { "line \($0)" }.joined(separator: "\n")
    #expect(KithMemoryChunks.split(text).map(\.line) == [1, 201, 401])
    #expect(KithMemoryChunks.split("").isEmpty == false)
}

@Test func formattedModeKeepsALongCodeFenceWholeButRawModeCutsIt() {
    let text = "```\n" + (1...450).map { "l\($0)" }.joined(separator: "\n") + "\n```"
    #expect(KithMemoryChunks.split(text).count == 1)
    #expect(KithMemoryChunks.split(text, raw: true).count > 1)
}

@Test func rawModeChopsAFileWithNoNewlines() {
    let chunks = KithMemoryChunks.split(String(repeating: "a", count: 9000), raw: true)
    #expect(chunks.count == 3 && chunks.allSatisfy { $0.line == 1 && $0.text.count <= KithMemoryChunks.pieceSize })
}
