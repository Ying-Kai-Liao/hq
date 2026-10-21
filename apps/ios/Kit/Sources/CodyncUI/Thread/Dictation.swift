import AVFoundation
import Speech
import SwiftUI

/// Dictation into the message box with on-device speech: the words appear as they're recognized,
/// after what was already typed; the mic again, or the recognizer finishing on a pause, stops it.
/// It uses the call's language setting.
@MainActor @Observable
final class Dictation {
    private(set) var listening = false
    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var heard: ((String) -> Void)?
    /// Bumped per start and stop, so a late result from an earlier recognition is dropped.
    @ObservationIgnored private var generation = 0

    /// `said` after what's already in the box, with one space between.
    static func join(_ before: String, _ said: String) -> String {
        if before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return said }
        if said.isEmpty { return before }
        return before.last?.isWhitespace == true ? before + said : before + " " + said
    }

    func start(heard: @escaping (String) -> Void) async {
        guard !listening, await AVAudioApplication.requestRecordPermission(), await Self.authorized() else { return }
        let recognizer = UserDefaults.standard.string(forKey: OnDeviceEngine.languageKey)
            .flatMap { $0.isEmpty ? nil : SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else { return }
        do {
            let audio = AVAudioSession.sharedInstance()
            // The call's session: a recording tap on a `.record` session fails on some routes.
            try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
            try audio.setActive(true)
        } catch {
            return
        }
        guard let format = try? MicTap.format(of: engine.inputNode) else {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return
        }
        generation += 1
        self.heard = heard
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.tap(request))
        engine.prepare()
        do {
            try engine.start()
        } catch {
            return stop()
        }
        listening = true
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results(self, generation: generation))
    }

    func stop() {
        generation += 1
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        heard = nil
        if listening { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        listening = false
    }

    private func recognized(_ text: String, final: Bool, generation: Int) {
        guard generation == self.generation else { return }
        heard?(text)
        if final { stop() }
    }

    private nonisolated static func tap(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    private nonisolated static func results(_ dictation: Dictation, generation: Int) -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in
                if let text { dictation.recognized(text, final: final, generation: generation) }
                if failed, generation == dictation.generation { dictation.stop() }
            }
        }
    }

    private nonisolated static func authorized() async -> Bool {
        await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
        }
    }
}
