@testable import KithUI
import Foundation
import Testing

// The call's audio chain, pure parts: WAV decode, edge fades, the playback ledger and the
// talk-over detector (fed synthetic frames, as there's no microphone in CI).

private func wav(_ samples: [Int16], rate: Int = 24000, channels: Int = 1) -> Data {
    var out = Data()
    func le<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) } }
    let bytes = samples.count * 2
    out.append(contentsOf: Array("RIFF".utf8)); le(UInt32(36 + bytes))
    out.append(contentsOf: Array("WAVEfmt ".utf8)); le(UInt32(16)); le(UInt16(1)); le(UInt16(channels))
    le(UInt32(rate)); le(UInt32(rate * channels * 2)); le(UInt16(channels * 2)); le(UInt16(16))
    out.append(contentsOf: Array("data".utf8)); le(UInt32(bytes))
    for s in samples { le(s) }
    return out
}

@Test func wavDecodesToFloatsAtItsOwnRate() {
    let decoded = ClipAudio.decodeWAV(wav([0, 16384, -16384, -32768]))
    #expect(decoded?.sampleRate == 24000)
    #expect(decoded?.samples == [0, 0.5, -0.5, -1])
}

@Test func stereoWavIsAveraged() {
    let decoded = ClipAudio.decodeWAV(wav([16384, 0, -16384, -16384], channels: 2))
    #expect(decoded?.samples == [0.25, -0.5])
}

@Test func notAWavDecodesToNil() {
    #expect(ClipAudio.decodeWAV(Data("hello".utf8)) == nil)
    #expect(ClipAudio.decodeWAV(Data()) == nil)
}

@Test func streamedWavWithZeroSizeTakesWhatIsThere() {
    var data = wav([1000, 2000, 3000])
    data.replaceSubrange(40..<44, with: [0, 0, 0, 0])
    #expect(ClipAudio.decodeWAV(data)?.samples.count == 3)
}

@Test func fadeSilencesTheEdgesAndLeavesTheMiddle() {
    var samples = [Float](repeating: 1, count: 2400) // 100 ms at 24 kHz; the fade is 120 samples
    ClipAudio.fade(&samples, sampleRate: 24000)
    #expect(samples[0] == 0)
    #expect(samples[2399] == 0)
    #expect(samples[60] > 0.45 && samples[60] < 0.55)
    #expect(samples[1200] == 1)
    // Rising then falling, so two clips joined end to start never step.
    #expect(samples[119] > samples[60])
    #expect(samples[2399 - 119] == samples[119])
}

@Test func fadeOnATinyClipStaysInside() {
    var samples: [Float] = [1, 1, 1]
    ClipAudio.fade(&samples, sampleRate: 24000)
    #expect(samples == [0, 1, 0]) // each side takes at most half
    var two = [Float](repeating: 1, count: 200)
    ClipAudio.fade(&two, sampleRate: 24000, seconds: 1) // longer than the clip: each side takes half
    #expect(two[0] == 0 && two[199] == 0)
}

@Test func ledgerDrainsWhenTheLastClipFinishes() {
    var ledger = PlaybackLedger()
    let a = ledger.schedule()
    let b = ledger.schedule()
    #expect(!ledger.idle)
    let r1 = ledger.completed(a)
    #expect(!r1)
    let r2 = ledger.completed(b)
    #expect(r2)
    #expect(ledger.idle)
}

@Test func ledgerIgnoresCompletionsFromBeforeACut() {
    var ledger = PlaybackLedger()
    let old = ledger.schedule()
    ledger.cut()
    #expect(ledger.idle)
    let fresh = ledger.schedule()
    let r3 = ledger.completed(old)
    #expect(!r3) // the dropped buffer reports in late
    #expect(!ledger.idle)
    let r4 = ledger.completed(fresh)
    #expect(r4)
}

// MARK: talk-over detector

/// Feeds `ms` of constant loudness in 10 ms frames; returns each event with the time it fired (ms into the run).
private func run(_ d: inout BargeInDetector, db: Double, ms: Int, from start: Int = 0, armed: Bool = true) -> [(BargeInDetector.Event, Int)] {
    var events: [(BargeInDetector.Event, Int)] = []
    var t = start
    while t < start + ms {
        t += 10
        if let e = d.feed(db: db, seconds: 0.01, at: Double(t) / 1000, armed: armed) { events.append((e, t)) }
    }
    return events
}

@Test func speechOverTheVoiceDucksThenStops() {
    var d = BargeInDetector()
    _ = run(&d, db: -62, ms: 500) // quiet room teaches the floor
    let events = run(&d, db: -30, ms: 500, from: 500)
    #expect(events.map(\.0) == [.duck, .stop])
    // Expected latency from the first loud frame in the harness: duck at 100 ms, stop at 400 ms.
    #expect(events[0].1 - 510 == 90)
    #expect(events[1].1 - 510 == 390)
    #expect(d.onsetAt == 0.51)
}

@Test func aCoughDucksThenTheVoiceComesBack() {
    var d = BargeInDetector()
    _ = run(&d, db: -62, ms: 500)
    var events = run(&d, db: -30, ms: 130, from: 500)
    events += run(&d, db: -62, ms: 500, from: 630)
    #expect(events.map(\.0) == [.duck, .resume])
}

@Test func shortGapsBetweenWordsOnlySlowTheCount() {
    var d = BargeInDetector()
    _ = run(&d, db: -62, ms: 500)
    var events = run(&d, db: -30, ms: 300, from: 500)
    events += run(&d, db: -62, ms: 50, from: 800) // a pause between words
    events += run(&d, db: -30, ms: 250, from: 850)
    #expect(events.map(\.0) == [.duck, .stop])
}

@Test func loudspeakerEchoInSyllableBurstsNeverAddsUpToAStop() {
    var d = BargeInDetector()
    _ = run(&d, db: -62, ms: 500)
    var events: [(BargeInDetector.Event, Int)] = []
    var t = 500
    for _ in 0..<10 { // 100 ms loud, 100 ms quiet, for two seconds
        events += run(&d, db: -30, ms: 100, from: t)
        events += run(&d, db: -62, ms: 100, from: t + 100)
        t += 200
    }
    #expect(!events.map(\.0).contains(.stop))
}

@Test func aBlipTooShortToDuckDoesNothing() {
    var d = BargeInDetector()
    _ = run(&d, db: -62, ms: 500)
    var events = run(&d, db: -30, ms: 50, from: 500)
    events += run(&d, db: -62, ms: 500, from: 550)
    #expect(events.isEmpty)
}

@Test func nothingFiresWhileTheVoiceIsNotPlaying() {
    var d = BargeInDetector()
    let events = run(&d, db: -20, ms: 1000, armed: false)
    #expect(events.isEmpty)
}

@Test func steadyRoomNoiseBecomesTheFloorInsteadOfTriggering() {
    var d = BargeInDetector()
    // A fan at -50 dB sits under the threshold and lifts the learned floor instead.
    _ = run(&d, db: -62, ms: 300)
    var events = run(&d, db: -50, ms: 3000, from: 300, armed: false)
    events += run(&d, db: -50, ms: 1000, from: 3300)
    #expect(events.isEmpty)
    #expect(d.floorDb > -55)
}

@Test func theNextTalkOverStartsFresh() {
    var d = BargeInDetector()
    _ = run(&d, db: -62, ms: 500)
    let first = run(&d, db: -30, ms: 500, from: 500)
    #expect(first.map(\.0) == [.duck, .stop])
    _ = run(&d, db: -62, ms: 100, from: 1000, armed: false) // the voice was cut
    let second = run(&d, db: -30, ms: 500, from: 1100)
    #expect(second.map(\.0) == [.duck, .stop])
}

@Test func rmsDbOfFullScaleSquareIsZero() {
    let loud = [Float](repeating: 1, count: 100)
    #expect(abs(loud.withUnsafeBufferPointer(rmsDb)) < 0.001)
    let half = [Float](repeating: 0.1, count: 100)
    #expect(abs(half.withUnsafeBufferPointer(rmsDb) + 20) < 0.001)
}
