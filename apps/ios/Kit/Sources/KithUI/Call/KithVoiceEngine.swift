import AVFoundation
import KithKit
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Kith", category: "KithVoice")

/// "Kith voice": listening is the on-device engine's (Apple speech); speaking is Phonon text to
/// speech run by the computer's kith serve, fetched clip by clip. Free, and nothing leaves the
/// user's own machines.
///
/// A reply is spoken while it is still being written: each finished sentence goes into the clip
/// queue once. The microphone stays on while it speaks (echo-cancelled), and talking over the voice
/// stops it at once; the turn goes on and what was said is sent as the next message.
///
/// Talk-over is two signals. Energy on the echo-cancelled microphone (`BargeInDetector`) ducks the
/// voice after ~100 ms of speech-level sound; two recognized words that aren't the bot's own text
/// cut it, and so does ~400 ms of sustained energy (conservative until tuned on a real phone). A duck that isn't followed by more sound (a cough)
/// is undone after ~300 ms of quiet.
@MainActor
final class KithVoiceEngine: OnDeviceEngine {
    struct Host {
        let status: @MainActor () async throws -> LocalVoiceStatus
        /// Starts the model download.
        let prepare: @MainActor () async throws -> LocalVoiceStatus
        /// One clip of WAV audio.
        let speak: @MainActor (String, String?) async throws -> Data
        let voice: @MainActor (LocalVoiceStatus) -> String?
    }

    /// A reply is spoken a sentence or two at a time, so the first words come early.
    static let clipChars = 160

    override var streamsReplies: Bool { true }

    private let host: Host
    private var voiceName: String?
    private var queue: ClipQueue<Data>!
    private var stream = SentenceStream()
    private var player: ClipPlayer!
    private let bargeIn: BargeInGate
    /// Bumped by every cut of the voice; a clip or pump from before it does nothing more.
    private var speakGeneration = 0
    /// A clip is playing or about to (the pump is running).
    private var pumping = false
    /// What was said since the user last spoke: the microphone hears it back, and it isn't the user.
    private var echoRef = ""
    private var working = false
    private var sentAt: Date?
    private var lastSpokenAt = Date.distantPast
    private var cued = false
    private var cueTask: Task<Void, Never>?
    private var firstEnqueuedAt: ContinuousClock.Instant?

    init(host: Host, send: @escaping (String) -> Void) {
        self.host = host
        var detector = BargeInDetector.Config()
        // A tuning knob for rooms where the default misfires (dB above the noise floor).
        let margin = UserDefaults.standard.double(forKey: "callBargeMarginDb")
        if margin > 0 { detector.marginDb = margin }
        bargeIn = BargeInGate(config: detector)
        super.init(send: send)
        self.send = { [weak self] text in
            self?.sentAt = .now
            self?.cued = false
            self?.firstEnqueuedAt = nil
            send(text)
        }
        talkOverEnabled = true
        queue = ClipQueue { [weak self] text in await self?.fetchClip(text) }
        player = ClipPlayer(engine: engine) { [unowned self] in try self.ensureEngineRunning() }
        prepareGraph = { [unowned self] in self.player.prepareGraph() }
        player.onDrained = { [weak self] in
            self?.bargeIn.setArmed(false)
            self?.finishedSpeaking()
        }
        let gate = bargeIn
        micFrame = { [weak self] db, seconds in
            guard let (event, onset) = gate.feed(db: db, seconds: seconds) else { return }
            Task { @MainActor in self?.bargeInEvent(event, onset: onset) }
        }
    }

    override var holdsEngine: Bool { !player.idle }

    /// The route changed under the engine: what was queued on it is gone, so the voice moves on to what comes next.
    override func engineConfigurationChanged() {
        player.reset()
        player.reconnect()
        bargeIn.setArmed(false)
        super.engineConfigurationChanged()
        finishedSpeaking()
    }

    override func interruptionBegan() {
        player.reset()
        bargeIn.setArmed(false)
        finishedSpeaking()
    }

    /// The speaker echoes into the microphone far more than an earpiece does: it needs a louder voice to count.
    override func setSpeaker(_ on: Bool) {
        super.setSpeaker(on)
        bargeIn.setSpeaker(on)
    }

    /// Energy on the microphone while the voice plays (see `BargeInDetector`).
    private func bargeInEvent(_ event: BargeInDetector.Event, onset: Double) {
        guard !ended else { return }
        let since = { (ProcessInfo.processInfo.systemUptime - onset) * 1000 }
        switch event {
        case .duck:
            guard phase == .speaking, !player.idle else { return }
            player.duck(true)
            log.info("talk-over: voice ducked \(Int(since())) ms after the first loud frame")
        case .resume:
            player.duck(false)
            log.info("talk-over: false alarm, voice back up")
        case .stop:
            guard phase == .speaking, !player.idle || pumping else { return }
            cutVoice()
            phase = .listening
            log.info("talk-over: voice stopped \(Int(since())) ms after the first loud frame")
        }
    }

    override func start() async {
        do {
            var status = try await host.status()
            guard !ended else { return }
            guard status.available else { return fail("Kith voice isn't available on this computer.") }
            voiceName = host.voice(status)
            if status.state != .ready {
                // The download runs while the call listens; the first reply waits for it.
                setWarning("Downloading voice…")
                status = try await host.prepare()
                if status.state == .error { setWarning(status.error ?? "The voice couldn't be downloaded.") }
            }
        } catch {
            guard !ended else { return }
            return fail("Kith voice isn't reachable on this computer (\(error.localizedDescription)). It may need a newer Kith. Pick another engine in call settings.")
        }
        guard !ended else { return }
        await super.start()
        guard !ended, !phase.isFailed else { return }
        cueTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.cue()
            }
        }
    }

    override func end() {
        super.end()
        cueTask?.cancel()
        cueTask = nil
        cutVoice()
    }

    override func setWorking(_ working: Bool) { self.working = working }

    /// A notice, or a whole reply from a watcher that doesn't stream: said after what's queued.
    override func speak(reply: String) { enqueue(SpokenText.from(reply)) }

    override func announce(_ notice: String) { enqueue(notice) }

    override func streamReply(id: String, text: String, final: Bool) {
        let ready = stream.feed(id, text, final: final)
        if !ready.isEmpty { enqueue(ready) } else if final { finishedSpeaking() }
    }

    /// Tap or Stop: the voice stops, the mic is already listening.
    override func interrupt() {
        guard phase == .speaking else { return }
        cutVoice()
        finishedSpeaking()
    }

    override func heardText(_ text: String) -> String { SpeechEcho.stripEcho(text, spoken: echoRef) }

    override func talkOver(_ words: String) -> Bool {
        // Two words or more that aren't the bot's own voice coming back through the speakers.
        guard SpeechEcho.wordCount(words) >= 2, !SpeechEcho.isEcho(words, spoken: echoRef) else { return false }
        cutVoice()
        phase = .listening
        log.info("talk-over: words heard, voice stopped")
        return true
    }

    override func listen() {
        // A new utterance: whatever the bot said before is no longer in the transcript.
        echoRef = ""
        super.listen()
    }

    /// Nothing left to say for now; the microphone goes on listening (it never stopped).
    override func finishedSpeaking() {
        guard phase == .speaking, !pumping, !queue.pending, player.idle else { return }
        if micOn { phase = .listening } else { listen() }
    }

    private func enqueue(_ text: String) {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ended, !said.isEmpty, phase != .starting, !phase.isFailed else { return }
        queue.add(CloudSpeechEngine.clips(said, limit: Self.clipChars))
        transcript.bot(said)
        echoRef += " " + said
        lastSpokenAt = .now
        if firstEnqueuedAt == nil { firstEnqueuedAt = .now }
        if phase != .speaking { phase = .speaking }
        if !pumping {
            pumping = true
            let generation = speakGeneration
            Task { await pump(generation) }
        }
    }

    private func cue() {
        guard SpeechCue.shouldCue(now: .now, sentAt: sentAt, lastSpokenAt: lastSpokenAt, working: working, cued: cued) else { return }
        cued = true
        enqueue("Working on it.")
    }

    private func pump(_ generation: Int) async {
        while true {
            let next: Data? = await queue.take()
            guard generation == speakGeneration, !ended else { return }
            guard let audio = next else { break }
            // Queued behind what's playing, not awaited: the next clip is on the node before this one ends.
            play(audio)
        }
        // A clip that couldn't be made drops the rest of this stretch of speech.
        queue.stop()
        pumping = false
        finishedSpeaking()
    }

    private func fetchClip(_ text: String) async -> Data? {
        do {
            let audio = try await host.speak(text, voiceName)
            setWarning(nil)
            return audio
        } catch {
            guard !Task.isCancelled else { return nil }
            log.error("speak: \(error.localizedDescription, privacy: .public)")
            // The call goes on listening; the reply is on screen.
            setWarning("Couldn't speak the reply (\(error.localizedDescription)).")
            return nil
        }
    }

    private func play(_ audio: Data) {
        let ok = player.schedule(audio) {
            if let started = self.firstEnqueuedAt {
                log.info("first clip playing \((ContinuousClock.now - started).formatted()) after its text was ready")
                self.firstEnqueuedAt = nil
            }
        }
        if ok { bargeIn.setArmed(true) }
    }

    /// Stops the voice, drops queued clips, and gives up what's still being written of the replies on air.
    private func cutVoice() {
        speakGeneration += 1
        stream.muteOpen()
        pumping = false
        queue.stop()
        bargeIn.setArmed(false)
        player.stop()
    }
}
