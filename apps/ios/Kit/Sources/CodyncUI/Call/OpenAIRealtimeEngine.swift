import AVFoundation
import CodyncKit
import Foundation
import Observation
import os
@preconcurrency import WebRTC

private let log = Logger(subsystem: "com.pokai.Codync", category: "Call")

/// OpenAI Realtime over WebRTC, phone ↔ OpenAI directly: the microphone is a WebRTC audio track,
/// the model's voice plays from the remote track, and events (tools, replies) go over `oai-events`.
/// The user's key stays on the computer, which mints the client secret; the host never sees audio.
@MainActor
@Observable
final class OpenAIRealtimeEngine: VoiceEngine {
    private(set) var phase: VoicePhase = .starting {
        didSet { onActivityChanged?(!ended && phase.isActive) }
    }
    private(set) var level: Float = 0
    var muted = false {
        didSet {
            mic?.isEnabled = !muted
            if muted { level = 0 }
        }
    }
    var provider: VoiceProvider? { .openAI }
    @ObservationIgnored var onActivityChanged: ((Bool) -> Void)?

    /// A short-lived credential for the provider, minted by the computer that holds the key.
    private let credential: @MainActor () async throws -> String
    private let op: CallOperator
    private var pc: RTCPeerConnection?
    private var events: RTCDataChannel?
    private var mic: RTCAudioTrack?
    private var delegate: RealtimeEvents?
    private var ended = false
    /// A response is being generated; new replies wait for it to finish.
    private var responding = false
    private var pending: [String] = []
    private var dropTimer: Task<Void, Never>?

    init(credential: @escaping @MainActor () async throws -> String, op: CallOperator) {
        self.credential = credential
        self.op = op
    }

    func start() async {
        guard await AVAudioApplication.requestRecordPermission() else {
            return fail("Allow the microphone for Codync in Settings to talk to your bots.")
        }
        do {
            let secret = try await credential()
            guard !ended else { return }
            try await connect(secret: secret)
        } catch {
            guard !ended else { return }
            fail(error.localizedDescription)
        }
    }

    private func connect(secret: String) async throws {
            let audio = RTCAudioSessionConfiguration.webRTC()
            audio.categoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
            RTCAudioSessionConfiguration.setWebRTC(audio)

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        let delegate = RealtimeEvents(owner: self)
        guard let pc = Self.factory.peerConnection(with: config, constraints: Self.noConstraints, delegate: delegate) else {
            throw VoiceError( "Couldn't start the call audio.")
        }
        self.delegate = delegate
        self.pc = pc
        let source = Self.factory.audioSource(with: Self.noConstraints)
        let mic = Self.factory.audioTrack(with: source, trackId: "mic")
        mic.isEnabled = !muted
        pc.add(mic, streamIds: ["call"])
        self.mic = mic
        let events = pc.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        events?.delegate = delegate
        self.events = events

        let offer = try await pc.offer(for: Self.noConstraints)
        try await pc.setLocalDescription(offer)
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/realtime/calls")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(offer.sdp.utf8)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard !ended else { return }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = (json?["error"] as? [String: Any])?["message"] as? String
            throw VoiceError( message ?? "OpenAI answered \(status).")
        }
        try await pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: String(decoding: data, as: UTF8.self)))
        dropTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, !Task.isCancelled, self.phase == .starting else { return }
            self.fail("Couldn't reach OpenAI.")
        }
    }

    func end() {
        ended = true
        onActivityChanged?(false)
        dropTimer?.cancel()
        events?.close()
        pc?.close()
        events = nil
        pc = nil
        mic = nil
        delegate = nil
    }

    func interrupt() {
        guard phase == .speaking else { return }
        send(["type": "response.cancel"])
        send(["type": "output_audio_buffer.clear"])
        phase = .listening
    }

    func speak(reply: String) {
        guard !ended, !phase.isFailed else { return }
        pending.append(op.reply(reply))
        flush()
    }

    func announce(_ notice: String) {
        guard !ended, !phase.isFailed else { return }
        pending.append(op.notice(notice))
        flush()
    }

    // MARK: events

    fileprivate func opened() {
        guard !ended else { return }
        dropTimer?.cancel()
        let tools: [[String: Any]] = CallOperator.tools.map {
            ["type": "function", "name": $0.name, "description": $0.description, "parameters": $0.parameters]
        }
        send([
            "type": "session.update",
            "session": [
                "type": "realtime",
                "instructions": op.instructions,
                "tools": tools,
                "audio": ["input": ["turn_detection": ["type": "semantic_vad"]]],
            ] as [String: Any],
        ])
        phase = .listening
        flush()
    }

    fileprivate func received(_ data: Data) {
        guard !ended, let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch msg["type"] as? String {
        case "input_audio_buffer.speech_started": level = muted ? 0 : 0.7
        case "input_audio_buffer.speech_stopped": level = 0
        case "output_audio_buffer.started": phase = .speaking
        case "output_audio_buffer.stopped", "output_audio_buffer.cleared": if phase == .speaking { phase = .listening }
        case "response.created": responding = true
        case "response.done":
            responding = false
            flush()
        case "response.function_call_arguments.done":
            guard let id = msg["call_id"] as? String, let name = msg["name"] as? String else { return }
            let args = (msg["arguments"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any]
            let output = op.call(name, arguments: args ?? [:])
            send(["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": id, "output": output]])
            // An empty entry asks for a response once this one is done, so the model speaks the result.
            pending.append("")
        case "error":
            let error = msg["error"] as? [String: Any]
            log.error("realtime: \(error?["message"] as? String ?? "?", privacy: .public)")
        default: break
        }
    }

    fileprivate func iceChanged(_ state: RTCIceConnectionState) {
        guard !ended else { return }
        switch state {
        case .connected, .completed: dropTimer?.cancel()
        case .disconnected:
            dropTimer?.cancel()
            dropTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                self.fail("Lost the connection to OpenAI.")
            }
        case .failed: fail("Lost the connection to OpenAI.")
        default: break
        }
    }

    /// Hands waiting replies (and tool results, as empty entries) to the model once it's free.
    private func flush() {
        guard !responding, phase.isActive, events?.readyState == .open, !pending.isEmpty else { return }
        for text in pending where !text.isEmpty {
            send(["type": "conversation.item.create", "item": [
                "type": "message", "role": "user", "content": [["type": "input_text", "text": text]],
            ] as [String: Any]])
        }
        pending.removeAll()
        responding = true
        send(["type": "response.create"])
    }

    private func send(_ event: [String: Any]) {
        guard let events, events.readyState == .open,
              let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        events.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    private func fail(_ message: String) {
        end()
        phase = .failed(message)
    }

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    private static let noConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
}

/// WebRTC callbacks arrive on its signaling thread; this hops them to the main actor.
private final class RealtimeEvents: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, Sendable {
    private let owner: WeakEngine

    @MainActor init(owner: OpenAIRealtimeEngine) { self.owner = WeakEngine(owner) }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let owner = owner
        Task { @MainActor in owner.value?.iceChanged(newState) }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        guard dataChannel.readyState == .open else { return }
        let owner = owner
        Task { @MainActor in owner.value?.opened() }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        let owner = owner
        Task { @MainActor in owner.value?.received(data) }
    }
}

private final class WeakEngine: Sendable {
    @MainActor weak var value: OpenAIRealtimeEngine?
    @MainActor init(_ value: OpenAIRealtimeEngine) { self.value = value }
}
