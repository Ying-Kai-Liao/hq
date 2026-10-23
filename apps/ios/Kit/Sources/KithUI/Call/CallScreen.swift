import AVFoundation
import AVKit
import KithKit
import SwiftUI
import UIKit

/// A voice call with a bot, full screen over its chat: the bot's living avatar, what is being
/// said, and the call's buttons. What you say goes out as ordinary messages, its final replies
/// are read aloud, and the chat gets a "Voice chat · 00:16" line when the call ends.
struct CallScreen: View {
    let botId: String
    let close: () -> Void
    /// An agent's call the person accepted: once the call is live the agent speaks first.
    var greet: String?
    @Environment(BotStore.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var session: (any VoiceEngine)?
    @State private var callID = UUID()
    @State private var startedAt = Date.now
    /// When the current cloud engine started, for this month's minutes.
    @State private var cloudStartedAt: Date?
    /// One line under the captions, e.g. why the call fell back to on-device voice.
    @State private var notice: String?
    @State private var settings = false
    @State private var speakerOn = true

    private var bot: Bot? { model.bots[botId] }
    private var color: Color { bot.map { AvatarPalette.color($0.avatarColor) } ?? Palette.accent }
    private var speaking: Bool { session?.phase == .speaking }
    private var statusText: String {
        CallStatus.text(phase: session?.phase, muted: session?.muted == true,
                        working: bot?.isWorking == true, warning: session?.warning)
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            avatar
            VStack(spacing: 4) {
                Text(bot?.name ?? "")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Palette.text)
                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(session?.phase.isFailed == true ? Palette.danger : Palette.secondary)
                // Audio leaves the phone: say where.
                if let provider = session?.provider {
                    Text("Voice by \(provider.name)").font(.caption).foregroundStyle(Palette.tertiary)
                }
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    Text(CallStatus.clock(Int(context.date.timeIntervalSince(startedAt))))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(Palette.tertiary)
                }
            }
            .padding(.top, 18)
            if case .failed(let message) = session?.phase {
                line(message, color: Palette.danger)
            } else if let notice {
                line(notice, color: Palette.secondary)
            }
            captions
                .padding(.top, 12)
            controls
                .padding(.bottom, 24)
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background.ignoresSafeArea())
        .animation(Motion.reduced(Motion.fade, reduceMotion), value: session?.phase)
        .animation(Motion.reduced(Motion.fade, reduceMotion), value: notice)
        .onAppear {
            startedAt = .now
            Analytics.shared.capture(.voiceCallStarted)
            begin(cloud: VoiceSettings.provider)
        }
        .onDisappear {
            session?.end()
            countCloudMinutes()
            model.endVoiceCall(callID)
            model.logCall(botId, seconds: Int(Date.now.timeIntervalSince(startedAt)))
        }
        .onChange(of: session?.phase) { _, phase in
            // A cloud engine that can't start or drops mid-call hands over to on-device voice.
            if case .failed(let message) = phase, let provider = session?.provider {
                countCloudMinutes()
                notice = "\(provider.name) isn't available (\(message)). Using on-device voice."
                begin(cloud: nil)
            }
        }
        .onChange(of: bot == nil) { _, gone in
            // The bot was deleted (on another device) mid-call.
            if gone { close() }
        }
        .kithSheet(isPresented: $settings) { VoiceChatSettingsView() }
    }

    /// Starts the engine: a realtime provider on the key kept by the computer, or on-device speech.
    private func begin(cloud provider: VoiceProvider?) {
        // Picks up the computer's newest models for the next call; this one starts right away.
        if provider != nil, let client = model.client {
            Task { if let status = try? await client.voiceStatus() { VoiceSettings.remember(status) } }
        }
        let op = CallOperator(model: model, botId: botId)
        let engine: any VoiceEngine
        if let provider, VoiceSettings.isSpeechMode(provider) {
            let transcribe = VoiceSettings.transcribeModel(provider)
            let speechModel = VoiceSettings.speechModel(provider)
            let voice = VoiceSettings.voice(provider)
            let client = { [model] () throws -> HostClient in
                guard let client = model.client else { throw VoiceError("Not connected to \(model.hostName).") }
                return client
            }
            engine = CloudSpeechEngine(provider: provider, speech: .init(
                transcribe: { try await VoiceSettings.inReadersScript(client().voiceTranscribe(provider, model: transcribe, wav: $0)) },
                speak: { try await client().voiceSpeak(provider, model: speechModel, voice: voice, text: $0) },
                send: { [model, botId] in model.sendSpoken($0, to: botId) }
            ))
            cloudStartedAt = .now
        } else if let provider {
            let chosen = VoiceSettings.model(provider)
            let voice = VoiceSettings.voice(provider)
            let credential: @MainActor () async throws -> String = { [model] in
                guard let client = model.client else { throw VoiceError("Not connected to \(model.hostName).") }
                return try await client.voiceSession(provider, model: chosen, voice: voice)
            }
            engine = switch provider {
            case .openAI: OpenAIRealtimeEngine(credential: credential, op: op)
            case .gemini: GeminiLiveEngine(model: chosen, voice: voice, credential: credential, op: op)
            }
            cloudStartedAt = .now
        } else if VoiceSettings.isKith {
            // Apple speech to listen; Phonon on the computer to speak.
            let client = { [model] () throws -> HostClient in
                guard let client = model.client else { throw VoiceError("Not connected to \(model.hostName).") }
                return client
            }
            engine = KithVoiceEngine(host: .init(
                status: { try await client().voiceLocalStatus() },
                prepare: { try await client().voiceLocalPrepare() },
                speak: { try await client().voiceLocalSpeak($0, voice: $1) },
                voice: { VoiceSettings.kithVoice(in: $0) }
            )) { [model, botId] in model.sendSpoken($0, to: botId) }
        } else {
            engine = OnDeviceEngine { [model, botId] in model.sendSpoken($0, to: botId) }
        }
        let streams = engine.streamsReplies
        engine.onActivityChanged = { [weak engine, model, botId, callID, greet] (active: Bool) in
            guard let engine else { return }
            if active, let greet { model.greetCall(greet) }
            Self.setActivity(active, engine: engine, streams: streams, model: model, botId: botId, callID: callID)
        }
        session = engine
        Task { await engine.start() }
    }

    /// Audio is active: the store hands this call the bot's replies; otherwise it lets go of it.
    private static func setActivity(_ active: Bool, engine: any VoiceEngine, streams: Bool, model: BotStore, botId: String, callID: UUID) {
        guard active else { return model.endVoiceCall(callID) }
        var stream: (@MainActor (String, String, Bool) -> Void)?
        var working: (@MainActor (Bool) -> Void)?
        if streams {
            stream = { [weak engine] id, text, isFinal in engine?.streamReply(id: id, text: text, final: isFinal) }
            working = { [weak engine] busy in engine?.setWorking(busy) }
        }
        model.beginVoiceCall(callID, botId: botId,
                             speak: { [weak engine] in engine?.speak(reply: $0) },
                             announce: { [weak engine] in engine?.announce($0) },
                             stream: stream, working: working,
                             end: { [weak engine] in engine?.end() })
        engine.setWorking(model.bots[botId]?.isWorking ?? false)
    }

    private func countCloudMinutes() {
        guard let provider = session?.provider, let since = cloudStartedAt else { return }
        VoiceUsage.add(seconds: Int(Date.now.timeIntervalSince(since)), for: provider)
        cloudStartedAt = nil
    }

    private func line(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(color)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .glass(in: Capsule())
            .padding(.top, 10)
            .transition(.opacity)
    }

    /// The bot, big; it swells with your voice while you speak and while it talks.
    /// Tapping it while it talks cuts the reply short.
    private var avatar: some View {
        let level = CGFloat(session?.level ?? 0)
        return Button { session?.interrupt() } label: {
            ZStack {
                Circle()
                    .fill(color.opacity(0.14))
                    .frame(width: 220, height: 220)
                    .scaleEffect(reduceMotion ? 1 : 1 + level * 0.18 + (speaking ? 0.06 : 0))
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: level)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: speaking)
                if let bot { CharacterAvatar(bot: bot, size: 168) }
            }
            .frame(width: 240, height: 240)
        }
        .buttonStyle(.plain)
        .disabled(!speaking)
        .accessibilityLabel(speaking ? "Interrupt" : bot?.name ?? "")
    }

    /// What you said and what the bot is saying, newest at the bottom; your words still being
    /// heard show dimmed under them.
    private var captions: some View {
        let lines = session?.captions ?? []
        let heard = session?.heard ?? ""
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(lines) { caption in
                        Text(caption.text)
                            .font(.body)
                            .foregroundStyle(caption.speaker == .you ? Palette.secondary : Palette.text)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .id(caption.id)
                    }
                    if !heard.isEmpty {
                        Text(heard)
                            .font(.body)
                            .foregroundStyle(Palette.tertiary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .id("heard")
                    }
                }
                .padding(.vertical, 8)
            }
            .scrollIndicators(.hidden)
            .onChange(of: lines.last?.text) { _, _ in scroll(proxy, lines: lines, heard: heard) }
            .onChange(of: heard) { _, _ in scroll(proxy, lines: lines, heard: heard) }
        }
        .frame(maxHeight: .infinity)
        .accessibilityLabel("Captions")
    }

    private func scroll(_ proxy: ScrollViewProxy, lines: [CallCaption], heard: String) {
        let target: AnyHashable? = heard.isEmpty ? lines.last?.id : "heard"
        guard let target else { return }
        withAnimation(Motion.reduced(.easeOut(duration: 0.2), reduceMotion)) { proxy.scrollTo(target, anchor: .bottom) }
    }

    private var controls: some View {
        HStack(spacing: 16) {
            let muted = session?.muted == true
            round(muted ? "Unmute" : "Mute", muted ? "mic.slash.fill" : "mic.fill", on: muted) { session?.muted.toggle() }
            if session?.supportsSpeaker == true {
                round(speakerOn ? "Switch to earpiece" : "Switch to speaker", speakerOn ? "speaker.wave.3.fill" : "ear", on: speakerOn) {
                    speakerOn.toggle()
                    session?.setSpeaker(speakerOn)
                }
            }
            // Bluetooth and AirPlay outputs, from the system.
            RoutePicker()
                .frame(width: Self.buttonSize, height: Self.buttonSize)
                .background(Palette.surface, in: Circle())
                .accessibilityLabel("Audio output")
            round("Call settings", "gearshape.fill") { settings = true }
            Button(action: close) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: Self.iconSize, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .background(Palette.danger, in: Circle())
            }
            .buttonStyle(PressScale())
            .accessibilityLabel("End call")
        }
    }

    private func round(_ label: String, _ symbol: String, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: Self.iconSize, weight: .medium))
                .foregroundStyle(on ? Palette.onAccent : Palette.text)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: Self.buttonSize, height: Self.buttonSize)
                .background(on ? Palette.accentFill : Palette.surface, in: Circle())
        }
        .buttonStyle(PressScale())
        .accessibilityLabel(label)
    }

    private static let buttonSize: CGFloat = 56
    private static let iconSize: CGFloat = 20
}

/// The system's output picker (AirPods, Bluetooth speakers, AirPlay).
private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.tintColor = UIColor(Palette.text)
        picker.activeTintColor = UIColor(Palette.accent)
        return picker
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}
