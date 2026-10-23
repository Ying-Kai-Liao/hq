import Foundation
import Testing
@testable import KithKit

@Test func theSeedMatchesMotionMdsTestVectors() {
    let vectors: [(String, UInt32, Int, Int, Double, Double, Double)] = [
        ("builder", 3_828_680_000, 0, 2, 0.08203125, 0.20703125, 0.890625),
        ("coder", 3_469_596_402, 2, 1, 0.3583984375, 0.8037109375, 0.8046875),
        ("designer", 3_572_601_220, 0, 1, 0.2734375, 0.943359375, 0.828125),
        ("lab", 1_650_496_244, 0, 2, 0.2958984375, 0.376953125, 0.3828125),
    ]
    for (id, seed, look, blink, fLook, fBlink, fBody) in vectors {
        let s = LivingSeed(id: id)
        #expect(s.seed == seed, "\(id)")
        #expect(s.lookTrack == look && s.blinkTrack == blink, "\(id)")
        #expect(s.fLook == fLook && s.fBlink == fBlink && s.fBody == fBody, "\(id)")
    }
}

@Test func mountPhaseWrapsIntoTheLoop() {
    // builder at now = 0 starts 0.082 x 14370 ms into look-idle-0 (acceptance check 1).
    let p = LivingSeed.phase(f: LivingSeed(id: "builder").fLook, length: 14370, nowMs: 0)
    #expect(abs(p - 1178.8) < 0.1)
    #expect(LivingSeed.phase(f: 0.5, length: 1000, nowMs: 1700) == 200)
}

@Test func sizeTiersAndTheirOverrides() {
    #expect(AvatarTier.tier(size: 92, reduceMotion: false) == .full)
    #expect(AvatarTier.tier(size: 40, reduceMotion: false) == .full)
    #expect(AvatarTier.tier(size: 39.9, reduceMotion: false) == .blink)
    #expect(AvatarTier.tier(size: 16, reduceMotion: false) == .blink)
    #expect(AvatarTier.tier(size: 15.9, reduceMotion: false) == .still)
    #expect(AvatarTier.tier(size: 92, reduceMotion: false, lowPower: true) == .blink)
    #expect(AvatarTier.tier(size: 92, reduceMotion: false, capped: true) == .blink)
    #expect(AvatarTier.tier(size: 92, still: true, reduceMotion: false) == .still)
    #expect(AvatarTier.tier(size: 92, reduceMotion: true) == .reduced)
    #expect(AvatarTier.tier(size: 10, reduceMotion: true) == .reduced)
}

@Test func aListFaceGlancesAtTheBlinkTierOnly() {
    // 46 pt (the chat list) is the blink tier: that is where the glance runs.
    #expect(AvatarTier.tier(size: 46, reduceMotion: false, capped: true) == .blink)
    #expect(AvatarTier.tier(size: 30, reduceMotion: false) == .blink)
    #expect(AvatarTier.tier(size: 15, reduceMotion: false) == .still)
    #expect(AvatarTier.tier(size: 46, still: true, reduceMotion: false) == .still)
    #expect(AvatarTier.tier(size: 30, reduceMotion: true) == .reduced)
}

@Test func theGlanceRestsAtBothEndsAndStaggersBySeed() {
    let k = BotGlance.keys
    #expect(k.first?.t == 0 && k.last?.t == 1)
    #expect(k.first?.x == 0 && k.last?.x == 0)
    #expect(zip(k, k.dropFirst()).allSatisfy { $0.t < $1.t })
    let seeds = (0..<40).map { LivingSeed(id: "bot-\($0)") }
    #expect(seeds.contains { BotGlance.side($0) < 0 } && seeds.contains { BotGlance.side($0) > 0 })
    #expect(Set(seeds.map(\.fLook)).count > 30)
    #expect(BotGlance.side(seeds[3]) == BotGlance.side(LivingSeed(id: "bot-3")))
}

@Test func aClosedEyeKeepsAboutThreeQuartersOfAPixel() {
    #expect(BotPose.closed(eyeHeight: 0.15, size: 92) == 0.10)
    #expect(abs(BotPose.closed(eyeHeight: 0.15, size: 24) - 0.2083) < 0.001)
}

@Test func doneOnlyPlaysAfterASecondOfWorkingAndOncePerFourSeconds() {
    var gate = DoneGate()
    let t0 = Date(timeIntervalSince1970: 1000)
    func step(_ from: CharacterAvatar.Mood?, _ to: CharacterAvatar.Mood, _ at: Double) -> Bool {
        gate.moodChanged(from: from, to: to, now: t0.addingTimeInterval(at))
    }
    _ = step(nil, .idle, 0)
    #expect(!step(.idle, .working, 0))
    #expect(!step(.working, .idle, 0.5))
    #expect(!step(.idle, .working, 0.6))
    #expect(step(.working, .idle, 2))
    // Flapping straight after: working again, idle again within 4 s of the last done.
    _ = step(.idle, .working, 2.1)
    #expect(!step(.working, .idle, 4))
    _ = step(.idle, .working, 4.1)
    #expect(step(.working, .idle, 6.5))
    // Needs-you and error never end in a done.
    _ = step(.idle, .working, 20)
    #expect(!step(.working, .error, 25))
}

@Test func statusMapsToMoods() throws {
    func mood(_ status: String) throws -> CharacterAvatar.Mood {
        try JSONDecoder().decode(Bot.self, from: Data(#"{"id":"b","status":"\#(status)"}"#.utf8)).mood
    }
    #expect(try mood("idle") == .idle)
    #expect(try mood("working") == .working)
    #expect(try mood("needsInput") == .needsInput)
    #expect(try mood("error") == .error)
}

@Test func theTracksLoadAndGazeStaysInsideTheLookBox() throws {
    for name in ["look-idle-0", "look-idle-3", "look-working", "look-error", "blink-0", "blink-2", "body-idle", "body-needs-enter", "body-done", "eye-done"] {
        #expect(LivingBotData.tracks[name] != nil, "\(name)")
    }
    #expect(LivingBotData.tracks["blink-1"]?.keys.contains { $0.s == nil } == true)
    let rig = try #require(LivingBotData.rigs["sound"])
    let g = BotGeometry(rig: rig, size: 100, placement: .identity)
    let up = g.gazeOffset(0, -1), down = g.gazeOffset(0, 1)
    #expect(abs(up.height + rig.look.up * 100) < 0.0001)
    #expect(abs(down.height - rig.look.down * 100) < 0.0001)
}
