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
