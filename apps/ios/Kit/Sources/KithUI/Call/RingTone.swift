import AVFoundation
import AudioToolbox
import Foundation

/// The ring of an incoming call: two soft beeps every two seconds, generated here so nothing is bundled, and a
/// vibration with each. The audio session is ambient, so the silent switch mutes the tone (the vibration stays);
/// `stop` lets the session go, and the call's own engine then takes it for the call.
@MainActor
final class RingTone {
    private var player: AVAudioPlayer?
    private var timer: Timer?

    func start() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default)
        try? session.setActive(true)
        player = try? AVAudioPlayer(data: Self.tone)
        player?.numberOfLoops = -1
        player?.volume = 0.6
        player?.play()
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Two 880 Hz beeps and silence, two seconds of 16-bit mono WAV; it loops.
    static let tone: Data = {
        let rate = 22_050
        var samples = [Int16](repeating: 0, count: rate * 2)
        for start in [0.0, 0.35] {
            let first = Int(start * Double(rate))
            for i in 0..<Int(0.22 * Double(rate)) {
                let t = Double(i) / Double(rate)
                let envelope = min(1, t / 0.02, (0.22 - t) / 0.04)
                samples[first + i] = Int16(sin(2 * .pi * 880 * t) * envelope * 9_000)
            }
        }
        var wav = Data()
        func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) } }
        let bytes = samples.count * 2
        wav.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes))
        wav.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(rate)); put(UInt32(rate * 2)); put(UInt16(2)); put(UInt16(16))
        wav.append(contentsOf: Array("data".utf8)); put(UInt32(bytes))
        for s in samples { put(s) }
        return wav
    }()
}
