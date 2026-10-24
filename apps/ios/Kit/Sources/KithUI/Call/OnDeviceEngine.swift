import AVFoundation
import KithKit
import NaturalLanguage
import Observation
import os
import Speech

private let log = Logger(subsystem: "com.yingkailiao.kith", category: "Call")

/// A hands-free voice loop with one bot, all on the phone: speech is transcribed on device,
/// sent as an ordinary message, and the bot's final replies are read aloud. The host sees text only.
@MainActor
@Observable
class OnDeviceEngine: VoiceEngine {
    var phase: VoicePhase = .starting {
        didSet { onActivityChanged?(!ended && phase.isActive) }
    }
    var provider: VoiceProvider? { nil }
    /// Keep the transport attached while audio is active, even without a visible UI update.
    @ObservationIgnored var onActivityChanged: ((Bool) -> Void)?
    /// What you're saying right now (live caption).
    private(set) var heard = ""
    /// The reply being read aloud.
    private(set) var said = ""
    /// The bot's recent words: the recognizer restarts after the voice ends and can hear its tail.
    private var recentSpoken = ""
    /// What was said on this call, for the call screen's captions.
    var transcript = CallTranscript()
    var captions: [CallCaption] { transcript.lines }
    var supportsSpeaker: Bool { true }
    /// Speaker rather than earpiece; kept so a route change (AirPods off) can put it back.
    private var speakerOn = true
    @ObservationIgnored private var routeObserver: (any NSObjectProtocol)?
    /// Microphone loudness, 0…1, while listening.
    private(set) var level: Float = 0
    /// A note under the call bar that doesn't end the call (a clip that couldn't be made).
    private(set) var warning: String?
    var muted = false {
        didSet {
            guard muted != oldValue, phase == .listening || (phase == .speaking && talkOverEnabled) else { return }
            if muted { stopListening() } else { restartListening() }
        }
    }

    /// Replaced by a subclass that wraps it (Kith voice notes when the message was sent).
    var send: (String) -> Void
    /// The microphone stays on while the voice speaks, echo-cancelled, so talking over it works.
    var talkOverEnabled = false
    /// The language picked in the call settings, else the phone's.
    private let recognizer = UserDefaults.standard.string(forKey: OnDeviceEngine.languageKey)
        .flatMap { $0.isEmpty ? nil : SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
    /// One engine for the microphone and, in Kith voice, the voice's player node: output through the
    /// same voice-processing unit is what the echo canceller subtracts from the microphone.
    let engine = AVAudioEngine()
    /// Every microphone buffer: loudness in dBFS and its length in seconds. Runs on the audio thread.
    var micFrame: (@Sendable (Double, Double) -> Void)?
    @ObservationIgnored private var configObserver: (any NSObjectProtocol)?
    /// The engine keeps running when listening stops (something is playing through it).
    var holdsEngine: Bool { false }
    /// Joins the player to the graph; runs before the engine starts.
    var prepareGraph: (() -> Void)?
    @ObservationIgnored private var interruptionObserver: (any NSObjectProtocol)?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Bumped per utterance so late callbacks from a cancelled recognition are dropped.
    private var generation = 0
    private var silence: Task<Void, Never>?
    private let synthesizer = AVSpeechSynthesizer()
    private var speechDone: SpeechDone?
    var ended = false

    /// Call settings (the gear), kept across calls.
    static let pauseKey = "callPause"
    static let rateKey = "callRate"
    /// On-device recognition language (a locale identifier); empty follows the system.
    static let languageKey = "callLanguage"

    /// Settings options: the system's language, then every language the recognizer supports, by name.
    static var languageOptions: [(String, String)] {
        let named = SFSpeechRecognizer.supportedLocales().map { ($0.identifier, Locale.current.localizedString(forIdentifier: $0.identifier) ?? $0.identifier) }
        return [("", "System")] + named.sorted { $0.1.localizedStandardCompare($1.1) == .orderedAscending }
    }

    /// A pause this long ends what you're saying and sends it.
    private var endOfUtterance: Duration {
        let seconds = UserDefaults.standard.double(forKey: Self.pauseKey)
        return .milliseconds(Int((seconds > 0 ? seconds : 1.5) * 1000))
    }

    init(send: @escaping (String) -> Void) {
        self.send = send
        let done = SpeechDone { [weak self] in Task { @MainActor in self?.finishedSpeaking() } }
        synthesizer.delegate = done
        speechDone = done
    }

    func start() async {
        guard await AVAudioApplication.requestRecordPermission() else {
            return fail("Allow the microphone for Kith in Settings to talk to your bots.")
        }
        guard await Self.speechAuthorized() else {
            return fail("Allow Speech Recognition for Kith in Settings to talk to your bots.")
        }
        guard let recognizer, recognizer.isAvailable else {
            return fail("Speech recognition isn't available for this language right now.")
        }
        guard !ended else { return }
        do {
            let audio = AVAudioSession.sharedInstance()
            // The speaker is an override (`setSpeaker`), not the category's default, so the earpiece stays possible.
            try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
            try audio.setActive(true)
            applyRoute()
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in Task { @MainActor in self?.engineConfigurationChanged() } }
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
            ) { [weak self] note in
                let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
                Task { @MainActor in self?.interruption(began: began) }
            }
            routeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
            ) { [weak self] _ in Task { @MainActor in self?.applyRoute() } }
        } catch {
            return fail("Couldn't start audio: \(error.localizedDescription)")
        }
        listen()
    }

    func setSpeaker(_ on: Bool) {
        speakerOn = on
        applyRoute()
    }

    /// The speaker override unless headphones or Bluetooth are connected: they keep the call.
    private func applyRoute() {
        guard !ended else { return }
        let audio = AVAudioSession.sharedInstance()
        let external: Set<AVAudioSession.Port> = [.headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio, .carAudio, .airPlay]
        let connected = audio.currentRoute.outputs.contains { external.contains($0.portType) }
        try? audio.overrideOutputAudioPort(speakerOn && !connected ? .speaker : .none)
    }

    func end() {
        ended = true
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        routeObserver = nil
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        onActivityChanged?(false)
        stopListening()
        if engine.isRunning { engine.stop() }
        synthesizer.stopSpeaking(at: .immediate)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The route or hardware format changed and the engine stopped itself: bring the microphone back on the new graph.
    func engineConfigurationChanged() {
        guard !ended else { return }
        log.info("audio engine configuration changed")
        if micOn { restartListening() }
    }

    /// A phone call, Siri or an alarm took the audio: what was playing is gone. When it ends the call picks up again.
    func interruption(began: Bool) {
        guard !ended else { return }
        log.info("audio interruption \(began ? "began" : "ended")")
        if began { return interruptionBegan() }
        try? AVAudioSession.sharedInstance().setActive(true)
        applyRoute()
        if micOn { restartListening() }
    }

    /// The system stopped the engine; a subclass drops what it had queued on it.
    func interruptionBegan() {}

    /// Runs the engine (voice processing first when talk-over needs it) if it isn't running.
    func ensureEngineRunning() throws {
        guard !engine.isRunning else { return }
        if talkOverEnabled, !engine.inputNode.isVoiceProcessingEnabled { try engine.inputNode.setVoiceProcessingEnabled(true) }
        prepareGraph?()
        engine.prepare()
        try engine.start()
    }

    /// Reads a reply aloud (the bot's final message), pausing the microphone meanwhile.
    func speak(reply markdown: String) {
        let text = SpokenText.from(markdown)
        guard !ended, !text.isEmpty, phase != .starting, !(phase.isFailed) else { return }
        stopListening()
        said = text
        recentSpoken = SpeechEcho.remember(recentSpoken, adding: text)
        transcript.bot(text)
        phase = .speaking
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice(for: text)
        let rate = UserDefaults.standard.float(forKey: Self.rateKey)
        utterance.rate = rate > 0 ? rate : AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }

    func announce(_ notice: String) { speak(reply: notice) }

    /// Cuts the reply short and goes back to listening.
    func interrupt() {
        guard phase == .speaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        listen()
    }

    // MARK: listening

    func listen() {
        phase = .listening
        restartListening()
    }

    /// The microphone is listening (a recognition is running).
    var micOn: Bool { task != nil }

    /// A fresh recognition without changing the phase (a new utterance, or the mic kept on while speaking).
    func restartListening() {
        stopListening()
        heard = ""
        guard !muted, !ended, let recognizer else { return }
        generation += 1
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        do {
            // Talking over the voice needs the speakers' sound taken out of the microphone's.
            if talkOverEnabled, !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
            let format = try MicTap.format(of: input)
            input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(request, frame: micFrame) { [weak self] level in
                Task { @MainActor in self?.level = level }
            })
            // A running engine (the voice is playing through it) is left alone: voice processing can't change under it.
            try ensureEngineRunning()
        } catch {
            log.error("audio engine: \(error.localizedDescription, privacy: .public)")
            return fail("Couldn't use the microphone: \(error.localizedDescription)")
        }
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results(self, generation: generation))
    }

    func stopListening() {
        silence?.cancel()
        silence = nil
        generation += 1
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        // In talk-over mode the engine keeps running between utterances: restarting it would make the echo canceller start over.
        if engine.isRunning, !holdsEngine, !talkOverEnabled { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        level = 0
    }

    /// The transcript as the user's words (a subclass drops the bot's own voice from it).
    func heardText(_ text: String) -> String { SpeechEcho.stripEcho(text, spoken: recentSpoken) }

    /// Words heard while the voice speaks: true if the user is talking over it (the subclass has then cut the voice).
    func talkOver(_ words: String) -> Bool { false }

    fileprivate func recognized(_ text: String, final: Bool, generation: Int) {
        guard generation == self.generation else { return }
        let words = heardText(text)
        if phase == .speaking {
            if !talkOver(words) {
                // The recognizer ended on the bot's own voice: start another.
                if final { restartListening() }
                return
            }
        }
        guard phase == .listening else { return }
        if words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Only the bot's tail coming back.
            if final { submit() }
            return
        }
        heard = words
        silence?.cancel()
        if final { return submit() }
        silence = Task {
            try? await Task.sleep(for: endOfUtterance)
            guard !Task.isCancelled else { return }
            submit()
        }
    }

    private func submit() {
        let text = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        stopListening()
        if !text.isEmpty {
            transcript.you(text)
            // The user's words are new; the bot's earlier words must not eat a deliberate repeat later.
            if phase != .speaking { recentSpoken = "" }
            send(text)
        }
        // Keep listening while the bot works: more messages fold into its next turn.
        if phase == .speaking { restartListening() } else { listen() }
    }

    func finishedSpeaking() {
        guard phase == .speaking else { return }
        listen()
    }

    func setWarning(_ text: String?) { warning = text }

    // Replies are spoken once final; Kith voice speaks them as they stream in.
    var streamsReplies: Bool { false }
    func streamReply(id: String, text: String, final: Bool) {}
    func setWorking(_ working: Bool) {}

    func fail(_ message: String) {
        stopListening()
        if engine.isRunning { engine.stop() }
        phase = .failed(message)
    }

    // MARK: audio-thread closures (built outside the main actor)

    private nonisolated static func tap(_ request: SFSpeechAudioBufferRecognitionRequest,
                                        frame: (@Sendable (Double, Double) -> Void)?,
                                        meter: @escaping @Sendable (Float) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            request.append(buffer)
            guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += samples[i] * samples[i] }
            // -50 dB (quiet room) … 0 dB mapped to 0…1.
            let db = 10 * log10(max(sum / Float(n), 1e-10))
            frame?(Double(db), Double(n) / buffer.format.sampleRate)
            meter(min(1, max(0, (db + 50) / 50)))
        }
    }

    private nonisolated static func results(_ session: OnDeviceEngine, generation: Int) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, _ in
            guard let result else { return }
            let text = result.bestTranscription.formattedString
            let final = result.isFinal
            Task { @MainActor in session.recognized(text, final: final, generation: generation) }
        }
    }

    private nonisolated static func speechAuthorized() async -> Bool {
        await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
        }
    }

    // MARK: voice

    /// A voice in the reply's own language (replies may be English while the phone is in Chinese).
    private static func voice(for text: String) -> AVSpeechSynthesisVoice? {
        guard let language = NLLanguageRecognizer.dominantLanguage(for: text) else { return nil }
        let code = switch language {
        case .traditionalChinese: "zh-TW"
        case .simplifiedChinese: "zh-CN"
        default: language.rawValue
        }
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(code) }
        // Prefer the phone's own region for the language, then the best quality installed.
        let preferred = voices.filter { $0.language == Locale.current.identifier(.bcp47) }
        return (preferred.isEmpty ? voices : preferred).max { $0.quality.rawValue < $1.quality.rawValue }
    }
}

/// Synthesizer delegate: a finished utterance hands back to listening. Cancelled ones don't.
private final class SpeechDone: NSObject, AVSpeechSynthesizerDelegate, Sendable {
    let onFinish: @Sendable () -> Void

    init(onFinish: @escaping @Sendable () -> Void) { self.onFinish = onFinish }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish()
    }
}
