import AVFoundation
import Foundation
import Speech

// codync-speech: transcribes the microphone on device with SFSpeechRecognizer and prints one
// JSON event per line: {"type":"started"}, {"type":"partial"|"final","text":…},
// {"type":"level","value":0…1}, {"type":"error","message":…}. It runs until stdin closes or
// SIGTERM. The desktop app (src/main/speech.ts) owns endpointing: it stops this process when
// the speaker pauses.

@MainActor
final class Recognizer {
    private let engine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastLevel = Date.distantPast

    init(locale: String?) {
        recognizer = locale.map { SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
    }

    func start() async {
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            return fail("Allow the microphone for Codync in System Settings to talk to your bots.")
        }
        let status = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
        guard status == .authorized else {
            return fail("Allow Speech Recognition for Codync in System Settings to talk to your bots.")
        }
        guard let recognizer, recognizer.isAvailable else {
            return fail("Speech recognition isn't available for this language right now.")
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            let level = Self.level(buffer)
            Task { @MainActor in self.report(level) }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            return fail("Couldn't start the microphone: \(error.localizedDescription)")
        }
        task = recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let message = error?.localizedDescription
            Task { @MainActor in
                if let text { emit(["type": final ? "final" : "partial", "text": text]) }
                // An error after the stream was ended on purpose is just the end.
                if let message, !final, self.request != nil { emit(["type": "error", "message": message]) }
            }
        }
        emit(["type": "started"])
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        request?.endAudio()
        request = nil
    }

    private func report(_ level: Float) {
        // ~20 updates a second is plenty for a level meter.
        guard Date().timeIntervalSince(lastLevel) > 0.05 else { return }
        lastLevel = Date()
        emit(["type": "level", "value": Double(level)])
    }

    private func fail(_ message: String) {
        emit(["type": "error", "message": message])
        exit(1)
    }

    nonisolated private static func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData?[0] else { return 0 }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<count { sum += data[i] * data[i] }
        let rms = (sum / Float(count)).squareRoot()
        // -50 dB … 0 dB → 0 … 1
        let db = 20 * log10(max(rms, 1e-6))
        return max(0, min(1, (db + 50) / 50))
    }
}

@MainActor func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

let arguments = CommandLine.arguments
let locale = arguments.firstIndex(of: "--locale").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }

signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let recognizer = MainActor.assumeIsolated { Recognizer(locale: locale) }
term.setEventHandler {
    MainActor.assumeIsolated { recognizer.stop() }
    // Give the recognizer a moment to deliver the final result.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { exit(0) }
}
term.resume()

// stdin closing (the app quit) ends the process too.
FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty {
        handle.readabilityHandler = nil
        DispatchQueue.main.async { exit(0) }
    }
}

Task { @MainActor in await recognizer.start() }
dispatchMain()
