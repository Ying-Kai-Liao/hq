import CoreGraphics
import Foundation

/// The pure rules of the living bots (MOTION.md sections 3, 6, 7): which loop a bot runs and
/// where in it, which tier a size gets, and when the "done" one-shot plays. Nothing here
/// touches a layer, so it is all testable.
struct LivingSeed: Equatable {
    let seed: UInt32
    let lookTrack: Int
    let blinkTrack: Int
    let fLook: Double
    let fBlink: Double
    let fBody: Double

    /// FNV-1a 32-bit over the UTF-8 of the bot id, split exactly as MOTION.md does, so a bot
    /// shows the same frame on the Mac and the iPhone.
    init(id: String) {
        var h: UInt32 = 0x811C_9DC5
        for byte in id.utf8 { h = (h ^ UInt32(byte)) &* 0x0100_0193 }
        seed = h
        lookTrack = Int(h % 4)
        blinkTrack = Int((h >> 2) % 3)
        fLook = Double((h >> 4) & 0x3FF) / 1024
        fBlink = Double((h >> 14) & 0x3FF) / 1024
        fBody = Double((h >> 24) & 0xFF) / 256
    }

    /// Mount phase in ms for a loop of `length` ms: `(now + f * length) mod length`.
    static func phase(f: Double, length: Double, nowMs: Double) -> Double {
        let p = (nowMs + f * length).truncatingRemainder(dividingBy: length)
        return p < 0 ? p + length : p
    }
}

enum AvatarTier: Equatable {
    /// Everything: look-around, breath, working reading, hops.
    case full
    /// Blinks, one-shots and a fixed eye pose per state.
    case blink
    /// Under 16 pt, or a widget frame: no motion.
    case still
    /// Reduce Motion: not even a blink; eyes centred.
    case reduced

    static let fullFrom: CGFloat = 40
    static let blinkFrom: CGFloat = 16
    /// No more than this many avatars run `full` in a window at once.
    static let fullCap = 6

    static func tier(size: CGFloat, still: Bool = false, reduceMotion: Bool, lowPower: Bool = false, capped: Bool = false) -> AvatarTier {
        if reduceMotion { return .reduced }
        if still || size < blinkFrom { return .still }
        if size >= fullFrom && !lowPower && !capped { return .full }
        return .blink
    }
}

/// The idle glance of the blink tier: a list face only blinks otherwise, so most rows would look
/// static. One quick look to a side every `period`, to the side the bot's seed picks, started at
/// the bot's own phase so a column of faces never looks in step.
enum BotGlance {
    static let period: Double = 9
    /// Gaze units; the full tier's look-around reaches further.
    static let reach = 0.55
    /// (fraction of the period, share of `reach`): rest, saccade out, hold, saccade back, rest.
    static let keys: [(t: Double, x: Double)] = [(0, 0), (0.78, 0), (0.795, 1), (0.88, 1), (0.895, 0), (1, 0)]

    static func side(_ seed: LivingSeed) -> Double { seed.seed & 1 == 0 ? -1 : 1 }
}

enum BotPose {
    /// Where the eyes rest in each mood when nothing moves them (gaze units): blink and still tiers.
    static func gaze(_ mood: CharacterAvatar.Mood) -> (x: Double, y: Double) {
        switch mood {
        case .idle, .needsInput: (0, 0)
        case .working: (0, 0.55)
        case .error: (0, 0.70)
        }
    }

    /// The held slump of an errored body.
    static let slump = (sx: 1.015, sy: 0.97)
    static let droop = 0.80

    /// A closed eye keeps about 0.75 px instead of vanishing.
    static func closed(eyeHeight: Double, size: CGFloat) -> Double {
        max(0.10, 0.75 / (eyeHeight * Double(size)))
    }
}

/// When the done one-shot plays: on working to idle after at least a second of working, at most
/// once every four seconds per avatar.
struct DoneGate {
    static let minWorking: TimeInterval = 1
    static let spacing: TimeInterval = 4

    private var workingSince: Date?
    private var lastDone: Date?

    mutating func moodChanged(from old: CharacterAvatar.Mood?, to new: CharacterAvatar.Mood, now: Date = .now) -> Bool {
        var play = false
        if old == .working, new == .idle, let since = workingSince, now.timeIntervalSince(since) >= Self.minWorking,
           lastDone.map({ now.timeIntervalSince($0) >= Self.spacing }) ?? true {
            play = true
            lastDone = now
        }
        if new == .working { if old != .working { workingSince = now } } else { workingSince = nil }
        return play
    }
}

/// The needs-you double hop is skipped when this bot played it in the last 10 s.
enum NeedsEntryThrottle {
    static let window: TimeInterval = 10
    nonisolated(unsafe) private static var last: [String: Date] = [:]
    private static let lock = NSLock()

    static func shouldPlay(id: String, now: Date = .now) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let t = last[id], now.timeIntervalSince(t) < window { return false }
        last[id] = now
        return true
    }
}

/// Eye and body geometry for a rig at a size, shared by the Core Animation view and the
/// still SwiftUI drawing so both put the eyes in the same place.
struct BotGeometry {
    let rig: BotRig
    let size: CGFloat
    let placement: BotPlacement

    /// The body canvas, in the avatar's box.
    var body: CGRect {
        let s = size * placement.scale
        return CGRect(x: (size - s) / 2 + placement.dx * size, y: (size - s) / 2 + placement.dy * size, width: s, height: s)
    }

    /// Offset in points for a gaze vector (+x right, +y down), limited per direction by the rig.
    func gazeOffset(_ gx: Double, _ gy: Double) -> CGSize {
        let s = Double(body.width)
        let x = gx < 0 ? gx * rig.look.left : gx * rig.look.right
        let y = gy < 0 ? gy * rig.look.up : gy * rig.look.down
        return CGSize(width: x * s, height: y * s)
    }
}
