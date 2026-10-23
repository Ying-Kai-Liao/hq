import Foundation

// Pure parts of the call's audio chain (no AVFoundation graph), so they can be tested with
// synthetic buffers: WAV decoding, clip edge fades, the playback ledger, and the energy detector
// that ducks and stops the voice when the user talks over it.

enum ClipAudio {
    struct Decoded: Equatable {
        var samples: [Float]
        var sampleRate: Double
    }

    /// Edge fade at both ends of a clip: kills the click of a cut waveform without eating speech.
    static let fadeSeconds = 0.005

    /// PCM16 WAV (mono, or stereo averaged) → floats in -1…1. nil for anything else.
    static func decodeWAV(_ data: Data) -> Decoded? {
        let bytes = [UInt8](data)
        guard bytes.count >= 12, bytes[0..<4].elementsEqual("RIFF".utf8), bytes[8..<12].elementsEqual("WAVE".utf8) else { return nil }
        func u16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
        var at = 12
        var rate = 0, channels = 0, bits = 0, format = 0
        while at + 8 <= bytes.count {
            let id = String(decoding: bytes[at..<at + 4], as: UTF8.self)
            let size = u32(at + 4)
            let body = at + 8
            if id == "fmt ", body + 16 <= bytes.count {
                format = u16(body); channels = u16(body + 2); rate = u32(body + 4); bits = u16(body + 14)
            } else if id == "data" {
                guard format == 1, bits == 16, (1...2).contains(channels), rate > 0 else { return nil }
                // A streamed WAV may carry 0 or 0xFFFFFFFF as the size: take what's there.
                let end = size == 0 || body + size > bytes.count ? bytes.count : body + size
                let frames = (end - body) / (2 * channels)
                var out = [Float](repeating: 0, count: frames)
                for i in 0..<frames {
                    var sum: Float = 0
                    for c in 0..<channels {
                        let p = body + (i * channels + c) * 2
                        sum += Float(Int16(bitPattern: UInt16(bytes[p]) | UInt16(bytes[p + 1]) << 8)) / 32768
                    }
                    out[i] = sum / Float(channels)
                }
                return Decoded(samples: out, sampleRate: Double(rate))
            }
            at = body + size + (size & 1)
        }
        return nil
    }

    /// Linear fade-in over the first and fade-out over the last `seconds` (never more than half the clip each).
    static func fade(_ samples: inout [Float], sampleRate: Double, seconds: Double = fadeSeconds) {
        let n = min(Int(sampleRate * seconds), samples.count / 2)
        guard n > 0 else { return }
        for i in 0..<n {
            let gain = Float(i) / Float(n)
            samples[i] *= gain
            samples[samples.count - 1 - i] *= gain
        }
    }
}

/// Which scheduled clips are still to play out. A cut bumps the generation so completions that
/// arrive afterwards (the node reports every dropped buffer) count for nothing.
struct PlaybackLedger {
    private(set) var generation = 0
    private(set) var inFlight = 0

    var idle: Bool { inFlight == 0 }

    /// A clip is handed to the player; the token goes with its completion.
    mutating func schedule() -> Int {
        inFlight += 1
        return generation
    }

    /// A scheduled clip finished playing. True when that was the last one (and it wasn't from before a cut).
    mutating func completed(_ token: Int) -> Bool {
        guard token == generation, inFlight > 0 else { return false }
        inFlight -= 1
        return inFlight == 0
    }

    mutating func cut() {
        generation += 1
        inFlight = 0
    }
}

/// Energy-based talk-over detector over the echo-cancelled microphone. Frames are fed in order
/// with their loudness in dBFS and duration.
///
///  - duck: speech-level energy for `duckSeconds` (lowers the voice at once; costs nothing if wrong)
///  - stop: the same energy for `stopSeconds` in total (the voice is cut; the words that follow go out as the
///    next message). Long on purpose: the loudspeaker's echo comes in syllable bursts and shouldn't add up to it.
///  - resume: after a duck, `resumeQuietSeconds` of quiet means it was a cough or a click
///
/// "Speech-level" is `marginDb` above a noise floor learned from the quiet frames (rises slowly,
/// falls quickly), never below `minDb`. The count is windowed: quiet frames take away twice their
/// length, so speech (mostly loud, short gaps) keeps climbing while echo bursts (loud about half
/// the time) don't.
struct BargeInDetector {
    enum Event: Equatable { case duck, stop, resume }

    struct Config: Equatable {
        var marginDb = 14.0
        var minDb = -45.0
        var duckSeconds = 0.10
        var stopSeconds = 0.40
        var resumeQuietSeconds = 0.30
    }

    /// Frame durations add up in floating point (ten 10 ms frames are 0.0999…).
    private static let eps = 1e-6

    var config: Config
    private(set) var floorDb = -60.0
    private(set) var loudFor = 0.0
    private(set) var quietFor = 0.0
    private(set) var ducked = false
    private(set) var stopped = false
    /// When the current burst of energy started (the caller's clock), for latency logs.
    private(set) var onsetAt: Double?

    init(config: Config = Config()) { self.config = config }

    var thresholdDb: Double { max(floorDb + config.marginDb, config.minDb) }

    /// `armed`: the voice is playing, so talking over it means something. Unarmed frames still teach the floor.
    mutating func feed(db: Double, seconds: Double, at now: Double, armed: Bool) -> Event? {
        let loud = db > thresholdDb
        if !loud { learnFloor(db) }
        guard armed else {
            loudFor = 0; quietFor = 0; ducked = false; stopped = false; onsetAt = nil
            return nil
        }
        if loud {
            if loudFor == 0 { onsetAt = now }
            loudFor += seconds
            quietFor = 0
            if loudFor + Self.eps >= config.stopSeconds, !stopped {
                stopped = true
                return .stop
            }
            if loudFor + Self.eps >= config.duckSeconds, !ducked, !stopped {
                ducked = true
                return .duck
            }
            return nil
        }
        quietFor += seconds
        loudFor = max(0, loudFor - 2 * seconds)
        guard quietFor + Self.eps >= config.resumeQuietSeconds, !stopped else { return nil }
        onsetAt = nil
        if ducked {
            ducked = false
            return .resume
        }
        return nil
    }

    private mutating func learnFloor(_ db: Double) {
        let alpha = db < floorDb ? 0.25 : 0.02
        floorDb = min(-35, max(-80, floorDb + (db - floorDb) * alpha))
    }
}

/// Loudness of a buffer of samples in dBFS (mean square).
func rmsDb(_ samples: UnsafeBufferPointer<Float>) -> Double {
    guard !samples.isEmpty else { return -100 }
    var sum: Float = 0
    for s in samples { sum += s * s }
    return Double(10 * log10(max(sum / Float(samples.count), 1e-10)))
}

/// The detector shared between the audio thread (which feeds it microphone frames) and the main
/// actor (which arms it while the voice plays).
final class BargeInGate: @unchecked Sendable {
    private let lock = NSLock()
    private var detector: BargeInDetector
    private var armed = false

    init(config: BargeInDetector.Config = .init()) { detector = BargeInDetector(config: config) }

    /// Earpiece/headphones hear little of the voice; the loudspeaker a lot.
    func setSpeaker(_ on: Bool) {
        lock.lock(); defer { lock.unlock() }
        detector.config.minDb = on ? BargeInDetector.Config().minDb + 7 : BargeInDetector.Config().minDb
    }

    func setArmed(_ on: Bool) {
        lock.lock(); defer { lock.unlock() }
        armed = on
    }

    /// An event and when its burst of energy began (`systemUptime`), if this frame produced one.
    func feed(db: Double, seconds: Double) -> (event: BargeInDetector.Event, onset: Double)? {
        lock.lock(); defer { lock.unlock() }
        let now = ProcessInfo.processInfo.systemUptime
        guard let event = detector.feed(db: db, seconds: seconds, at: now, armed: armed) else { return nil }
        return (event, detector.onsetAt ?? now)
    }
}
