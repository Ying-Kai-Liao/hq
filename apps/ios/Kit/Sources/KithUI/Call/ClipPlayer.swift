import AVFoundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Kith", category: "KithVoice")

/// Plays the voice's clips through a player node on the call's own AVAudioEngine, the one whose
/// input has voice processing on. Output that goes through the same voice-processing unit is the
/// echo canceller's reference, so the microphone hears the user and not the bot; the separate
/// AVAudioPlayer this replaces was invisible to it.
///
/// Clips are converted once (PCM16 → float, faded at the edges) and queued on the node back to
/// back, so the next one starts the instant the last sample of the one before has played.
@MainActor
final class ClipPlayer {
    /// The format every clip is brought to. The mixer resamples to the hardware's rate.
    static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    /// While a possible talk-over is being judged, the voice is this loud.
    static let duckedVolume: Float = 0.2

    private let engine: AVAudioEngine
    private let node = AVAudioPlayerNode()
    /// Makes sure the engine is running (the owner knows about voice processing and the tap).
    private let startEngine: () throws -> Void
    private var ramp: Task<Void, Never>?
    private var attached = false
    private var ledger = PlaybackLedger()
    /// Every queued clip has played out.
    var onDrained: (() -> Void)?

    init(engine: AVAudioEngine, startEngine: @escaping () throws -> Void) {
        self.engine = engine
        self.startEngine = startEngine
    }

    var idle: Bool { ledger.idle }

    /// Queues a clip behind the ones already queued. False if it couldn't be read or the engine wouldn't run.
    func schedule(_ wav: Data, started: () -> Void) -> Bool {
        guard let decoded = ClipAudio.decodeWAV(wav), !decoded.samples.isEmpty, let buffer = Self.buffer(decoded) else {
            log.error("unreadable clip")
            return false
        }
        do {
            try startEngine() // builds the graph (`prepareGraph`) before the engine's first start
            prepareGraph()
        } catch {
            log.error("player: \(error.localizedDescription, privacy: .public)")
            return false
        }
        let token = ledger.schedule()
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.completed(token) }
        }
        if !node.isPlaying {
            ramp?.cancel()
            node.volume = ducked ? Self.duckedVolume : 1
            node.play()
            started()
        }
        return true
    }

    private var ducked = false

    /// A ~10 ms ramp, not a step, so ducking doesn't click.
    func duck(_ on: Bool) {
        ducked = on
        let target = on ? Self.duckedVolume : 1
        ramp?.cancel()
        let from = node.volume
        ramp = Task { @MainActor [weak self] in
            for step in 1...4 {
                try? await Task.sleep(for: .milliseconds(3))
                guard !Task.isCancelled, let self else { return }
                self.node.volume = from + (target - from) * Float(step) / 4
            }
        }
    }

    /// Drops what's queued and stops at once.
    func stop() {
        ledger.cut()
        ramp?.cancel()
        ducked = false
        guard attached else { return }
        node.stop()
        node.volume = 1
    }

    /// The engine was rebuilt under us (route change, interruption): what was queued is gone.
    func reset() { stop() }

    /// After a route change the output's format can differ (AirPods): join mixer and output again on it.
    func reconnect() {
        guard attached else { return }
        engine.connect(node, to: engine.mainMixerNode, format: Self.format)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: engine.outputNode.outputFormat(forBus: 0))
    }

    private func completed(_ token: Int) {
        if ledger.completed(token) {
            // Nothing else is queued: park the node so the next clip starts it afresh.
            node.stop()
            onDrained?()
        }
    }

    /// Player → mixer → output, built before the engine first starts (the owner calls it ahead of
    /// `prepare`), not spliced into a running graph.
    func prepareGraph() {
        guard !attached else { return }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: Self.format)
        attached = true
    }

    /// Float samples at the clip's own rate → a buffer in `format`, converted by AVAudioConverter if the rates differ.
    private static func buffer(_ clip: ClipAudio.Decoded) -> AVAudioPCMBuffer? {
        var samples = clip.samples
        ClipAudio.fade(&samples, sampleRate: clip.sampleRate)
        let source = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: clip.sampleRate, channels: 1, interleaved: false)!
        guard let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        if clip.sampleRate == format.sampleRate { return input }
        guard let converter = AVAudioConverter(from: source, to: format) else { return nil }
        let capacity = AVAudioFrameCount(Double(samples.count) * format.sampleRate / clip.sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var given = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if given {
                status.pointee = .endOfStream
                return nil
            }
            given = true
            status.pointee = .haveData
            return input
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }
}
