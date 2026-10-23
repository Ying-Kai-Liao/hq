import AVFoundation
import KithKit
import SwiftUI

/// Voice chat settings: which voice carries calls (Apple's on this device, Kith's on the computer, or OpenAI /
/// Gemini on the user's own key kept by the computer), the voice and the keys. Opened from a call's gear
/// (a sheet) and from a computer's page in settings (pushed); the computer is the `BotStore` in the environment,
/// and a segmented control picks another when the account has two or more.
public struct VoiceChatSettingsView: View {
    var pushed = false
    @Environment(BotStore.self) private var store
    @Environment(AccountStore.self) private var accounts
    @Environment(\.dismiss) private var pop
    @State private var chosen: ComputerID?

    public init(pushed: Bool = false) { self.pushed = pushed }

    /// Computers whose keys and voice this person can change: their own, and online to be asked.
    private var choices: [BotStore] {
        accounts.ownedComputers.compactMap { accounts.store(for: $0.id) }.filter { $0.connection == .online || $0.computer.id == store.computer.id }
    }

    private var active: BotStore {
        chosen.flatMap { id in choices.first { $0.computer.id == id } } ?? store
    }

    public var body: some View {
        VStack(spacing: 0) {
            if pushed {
                ScreenHeader {
                    BackButton { pop() }
                } title: {
                    Text("Voice chat").font(.body.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
                } trailing: {
                    EmptyView()
                }
            } else {
                ModalHeader("Voice chat")
            }
            CardForm {
                if choices.count > 1 {
                    SegmentedChoice(selection: Binding(get: { active.computer.id }, set: { chosen = $0 }),
                                    options: choices.map { (id: $0.computer.id, label: $0.hostName) })
                }
                VoiceChatSettingsBody(store: active)
                    .environment(active)
                    .id(active.computer.id)
            }
        }
        .background(Palette.background)
        .modifier(HidesNavigationBarWhenPushed(pushed: pushed))
    }
}

private struct HidesNavigationBarWhenPushed: ViewModifier {
    let pushed: Bool

    func body(content: Content) -> some View {
        if pushed { content.hidesSystemNavigationBar() } else { content }
    }
}

/// One computer's voice settings: engine, voice, keys.
private struct VoiceChatSettingsBody: View {
    @AppStorage(VoiceSettings.engineKey) private var engine = "device"
    @AppStorage(OnDeviceEngine.rateKey) private var rate = Double(AVSpeechUtteranceDefaultSpeechRate)
    @AppStorage(OnDeviceEngine.languageKey) private var language = ""
    @State private var languages = OnDeviceEngine.languageOptions
    @Environment(BotStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var keys: [VoiceKeyModel]

    init(store: BotStore) {
        _keys = State(initialValue: VoiceProvider.allCases.map { VoiceKeyModel(provider: $0, store: store) })
    }

    var body: some View {
        Group {
            CardSection("Engine", footer: engineFooter) {
                ForEach(engines, id: \.id) { option in
                    Button { withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { engine = option.id } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Palette.text)
                                .opacity(engine == option.id ? 1 : 0)
                                .frame(width: 16)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.title).foregroundStyle(Palette.text)
                                Text(option.detail).font(.caption).foregroundStyle(Palette.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(engine == option.id ? .isSelected : [])
                }
            }

            CardSection("Voice") {
                if let provider = VoiceProvider(rawValue: engine) {
                    ModeRows(provider: provider).id(provider)
                } else if engine == VoiceSettings.kithEngine {
                    languageRow
                    PauseRow()
                } else {
                    ValueRow("Language", detail: "The language you speak in calls.") {
                        ChoicePicker(selection: $language, options: languages)
                    }
                    ValueRow("Reading speed") {
                        ChoicePicker(selection: $rate, options: [
                            (0.42, "Slower"), (Double(AVSpeechUtteranceDefaultSpeechRate), "Normal"), (0.56, "Faster"),
                        ])
                    }
                    PauseRow()
                }
            }
            if engine == VoiceSettings.kithEngine {
                KithVoiceSettings()
            }
            if let provider = VoiceProvider(rawValue: engine), let key = keys.first(where: { $0.provider == provider }) {
                ProviderVoiceSettings(provider: provider, key: key).id(provider)
            }

            ApiKeysSection(keys: keys)
        }
    }

    private var engines: [(id: String, title: String, detail: String)] {
        [
            ("device", "On device", "private, works offline, simpler voice"),
            (VoiceSettings.kithEngine, "Kith voice", "runs on \(store.hostName) · live captions"),
            (VoiceProvider.openAI.rawValue, "OpenAI Realtime", "needs an API key"),
            (VoiceProvider.gemini.rawValue, "Gemini Live", "needs an API key"),
        ]
    }

    private var languageRow: some View {
        ValueRow("Language", detail: "The language you speak in calls. The voice speaks English.") {
            ChoicePicker(selection: $language, options: languages)
        }
    }

    private var engineFooter: String {
        if engine == VoiceSettings.kithEngine {
            return "Apple speech on this device to listen, a voice that runs on your computer to talk. Applies from the next call."
        }
        guard let provider = VoiceProvider(rawValue: engine) else {
            return "Apple speech, on this device. Applies from the next call."
        }
        return "Your own \(provider.name) key, billed by \(provider.name). Applies from the next call."
    }
}

/// Kith voice: the computer's Phonon model (state, download) and the voice. The computer is asked,
/// so an older one shows why it can't.
private struct KithVoiceSettings: View {
    @Environment(BotStore.self) private var store
    @State private var status: LocalVoiceStatus?
    /// Why the voice can't be used, when the computer can't say.
    @State private var problem: String?
    @State private var voice = ""

    private var downloading: Bool { status?.state == .downloading }

    var body: some View {
        CardSection("Kith voice model", footer: hint ?? "About 65 MB, downloaded once.") {
            ValueRow("Voice model", detail: stateText) {
                if downloading {
                    ProgressView(value: status?.progress ?? 0)
                        .frame(width: 80)
                        .accessibilityLabel("Downloading the voice")
                } else if let status, status.available, status.state != .ready {
                    Button(status.state == .error ? "Retry" : "Download") { Task { await refresh(prepare: true) } }
                        .buttonStyle(.primary)
                }
            }
            if let status, status.available, !status.voices.isEmpty {
                ValueRow("Voice") {
                    ChoicePicker(selection: $voice, options: status.voices.map { ($0, $0) })
                }
            }
        }
        .task { await refresh(prepare: false) }
        .task(id: downloading) {
            // Progress while the model downloads.
            while downloading, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                await refresh(prepare: false)
            }
        }
        .onChange(of: voice) { _, v in
            if !v.isEmpty { UserDefaults.standard.set(v, forKey: VoiceSettings.kithVoiceKey) }
        }
    }

    private var stateText: String {
        switch status?.state {
        case .ready: "Ready"
        case .downloading: "Downloading…"
        case .error: "Failed"
        default: status?.available == false ? "Unavailable" : "Not downloaded"
        }
    }

    private var hint: String? {
        if let problem { return problem }
        guard let status else { return nil }
        if !status.available { return "Kith voice isn't available on \(store.hostName)." }
        return status.state == .error ? (status.error ?? "The voice couldn't be downloaded.") : nil
    }

    private func refresh(prepare: Bool) async {
        guard let client = store.client else {
            problem = "Not connected to \(store.hostName)."
            return
        }
        do {
            let next = prepare ? try await client.voiceLocalPrepare() : try await client.voiceLocalStatus()
            status = next
            problem = nil
            voice = VoiceSettings.kithVoice(in: next) ?? ""
        } catch {
            problem = "\(store.hostName) can't do Kith voice yet. Update Kith there. (\(error.localizedDescription))"
        }
    }
}

/// A provider's mode, and the pause that ends what you say when it's Speech.
private struct ModeRows: View {
    @AppStorage private var mode: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(provider: VoiceProvider) {
        _mode = AppStorage(wrappedValue: "realtime", VoiceSettings.modeKey(provider))
    }

    var body: some View {
        ValueRow("Mode", detail: mode == "speech" ? "Sent when you pause, replies read aloud." : "A live conversation. Talk over replies.") {
            ChoicePicker(selection: $mode.animation(Motion.reduced(Motion.layout, reduceMotion)),
                         options: [("realtime", "Realtime"), ("speech", "Speech")])
        }
        if mode == "speech" { PauseRow() }
    }
}

/// How long a silence ends what you say, before it's sent.
private struct PauseRow: View {
    @AppStorage(OnDeviceEngine.pauseKey) private var pause = 1.5

    var body: some View {
        ValueRow("Send after a pause of", detail: "Longer leaves time to think mid-sentence.") {
            ChoicePicker(selection: $pause, options: [(1.0, "1 s"), (1.5, "1.5 s"), (2.5, "2.5 s")])
        }
    }
}

/// One provider's key on the computer: whether it's saved, a test, and the replace and remove that need a place to type.
/// Shared by the key row, its page and the provider's model settings, so each sees the others' changes.
@MainActor
@Observable
private final class VoiceKeyModel {
    let provider: VoiceProvider
    let store: BotStore
    /// nil while the computer hasn't answered yet.
    var saved: Bool?
    var busy = false
    var replacing = false
    var key = ""
    var result: (ok: Bool, text: String)?
    private var testedAt: Date?

    /// Keys are entered on the computer itself (the host takes `setVoiceKey` from loopback only).
    static let canEditKey = false

    init(provider: VoiceProvider, store: BotStore) {
        self.provider = provider
        self.store = store
        let stamp = UserDefaults.standard.double(forKey: testedKey)
        testedAt = stamp > 0 ? Date(timeIntervalSince1970: stamp) : nil
    }

    var hasKey: Bool { saved == true }
    private var testedKey: String { "voiceKeyTested.\(store.computer.id).\(provider.rawValue)" }

    /// "Saved on Mac mini · tested today", or why there's no key.
    var detail: String {
        switch saved {
        case nil: return "Checking…"
        case false: return "not set"
        case true:
            guard let testedAt else { return "Saved on \(store.hostName)" }
            let when = Calendar.current.isDateInToday(testedAt) ? "today" : "\(RelativeTime.short(testedAt)) ago"
            return "Saved on \(store.hostName) · tested \(when)"
        }
    }

    func load() async {
        guard let client = store.client else {
            saved = false
            result = (false, "Not connected to \(store.hostName).")
            return
        }
        do {
            let status = try await client.voiceStatus()
            VoiceSettings.remember(status)
            saved = status.configured(provider)
        } catch {
            saved = false
            result = (false, error.localizedDescription)
        }
    }

    /// A pasted key is checked with the provider by the computer before it's kept. With a key
    /// saved, Test starts a call credential with the chosen model and voice.
    func test() {
        let typed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty || hasKey else { return }
        run { [self] client in
            if typed.isEmpty || !replacing && hasKey {
                let voice = VoiceSettings.voice(provider)
                if UserDefaults.standard.string(forKey: VoiceSettings.modeKey(provider)) == "speech" {
                    _ = try await client.voiceSpeak(provider, model: VoiceSettings.speechModel(provider), voice: voice, text: "OK")
                } else {
                    _ = try await client.voiceSession(provider, model: VoiceSettings.model(provider), voice: voice)
                }
                result = (true, "Key works")
            } else {
                saved = try await client.setVoiceKey(typed, for: provider).configured(provider)
                key = ""
                replacing = false
                result = (true, "Key works and is saved on \(store.hostName)")
            }
            let now = Date()
            testedAt = now
            UserDefaults.standard.set(now.timeIntervalSince1970, forKey: testedKey)
        }
    }

    func remove() {
        run { [self] client in
            saved = try await client.setVoiceKey("", for: provider).configured(provider)
            result = nil
            testedAt = nil
            UserDefaults.standard.removeObject(forKey: testedKey)
        }
    }

    private func run(_ work: @escaping @MainActor (HostClient) async throws -> Void) {
        guard !busy else { return }
        guard let client = store.client else {
            result = (false, "Not connected to \(store.hostName).")
            return
        }
        busy = true
        result = nil
        Task {
            do {
                try await work(client)
            } catch {
                result = (false, error.localizedDescription)
            }
            busy = false
        }
    }
}

/// API keys: one row per provider; a row opens that key's page.
private struct ApiKeysSection: View {
    let keys: [VoiceKeyModel]
    @State private var open: VoiceProvider?

    var body: some View {
        CardSection("API keys", footer: "Keys are saved on the computer, never on this iPhone.") {
            ForEach(keys, id: \.provider) { key in
                Button { open = key.provider } label: { ApiKeyRow(key: key) }
                    .buttonStyle(.plain)
            }
        }
        .task { for key in keys { await key.load() } }
        .navigationDestination(item: $open) { provider in
            if let key = keys.first(where: { $0.provider == provider }) { ApiKeyPage(key: key) }
        }
    }
}

private struct ApiKeyRow: View {
    let key: VoiceKeyModel

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "lock")
                .foregroundStyle(Palette.tertiary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(key.provider.name).foregroundStyle(Palette.text)
                Text(key.detail).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if VoiceKeyModel.canEditKey {
                Text(key.hasKey ? "Replace" : "Add").foregroundStyle(Palette.accent)
            } else {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.tertiary)
            }
        }
        .contentShape(Rectangle())
    }
}

/// One key's page: Test, and where the key is replaced or removed.
private struct ApiKeyPage: View {
    @Bindable var key: VoiceKeyModel
    @Environment(\.dismiss) private var pop
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader {
                BackButton { pop() }
            } title: {
                Text("\(key.provider.name) key").font(.body.weight(.semibold)).foregroundStyle(Palette.text).lineLimit(1)
            } trailing: {
                EmptyView()
            }
            CardForm {
                CardSection(footer: footer) {
                    if key.hasKey && !key.replacing {
                        HStack(spacing: 10) {
                            Image(systemName: "key.fill").foregroundStyle(Palette.secondary).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Key saved").foregroundStyle(Palette.text).lineLimit(1)
                                Text("Stays on \(key.store.hostName)").font(.caption).foregroundStyle(Palette.tertiary).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            if key.busy { Spinner() }
                        }
                        Button(action: key.test) { Label("Test key", systemImage: "checkmark.seal").frame(maxWidth: .infinity, alignment: .leading) }
                            .buttonStyle(.plain)
                            .foregroundStyle(Palette.accent)
                            .disabled(key.busy)
                        if VoiceKeyModel.canEditKey {
                            Button { key.replacing = true; key.result = nil } label: {
                                Label("Replace key", systemImage: "pencil").frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Palette.accent)
                            Button(role: .destructive, action: key.remove) {
                                Label("Remove key", systemImage: "trash").frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Palette.danger)
                            .disabled(key.busy)
                        }
                    } else if VoiceKeyModel.canEditKey {
                        keyEntry
                    } else if key.saved == false {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("No \(key.provider.name) key on \(key.store.hostName)").foregroundStyle(Palette.text)
                            Text("Add it in Kith on that computer: Computers & devices, then Voice chat.")
                                .font(.caption)
                                .foregroundStyle(Palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let result = key.result {
                        Label(result.text, systemImage: result.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(result.ok ? Palette.secondary : Palette.danger)
                            .transition(.opacity)
                    }
                }
            }
            .animation(Motion.reduced(Motion.layout, reduceMotion), value: key.replacing)
            .animation(Motion.reduced(Motion.fade, reduceMotion), value: key.result?.text)
        }
        .background(Palette.background)
        .hidesSystemNavigationBar()
    }

    private var footer: String { "Keys are saved on the computer, never on this iPhone." }

    /// Paste a key; the computer checks it with the provider before keeping it.
    private var keyEntry: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                SecureField("API key", text: $key.key, prompt: Text(key.provider.keyPrompt))
                    .plainTextInput()
                    .textFieldStyle(.plain)
                    .onSubmit(key.test)
                if key.busy {
                    Spinner()
                } else {
                    Button("Save", action: key.test)
                        .buttonStyle(.primary)
                        .disabled(key.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            HStack {
                WebLink("Get a key from \(key.provider.name)", url: key.provider.keyPage).font(.footnote)
                Spacer()
                if key.replacing {
                    Button("Cancel") { key.replacing = false; key.key = ""; key.result = nil }
                        .buttonStyle(.plain)
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                }
            }
        }
    }
}

/// One provider's models, voice and this month's minutes. Only usable once its key is saved.
private struct ProviderVoiceSettings: View {
    let provider: VoiceProvider
    let key: VoiceKeyModel
    @Environment(BotStore.self) private var store
    @AppStorage private var mode: String
    @State private var voice = ""
    @State private var model = ""
    @State private var transcribeModel = ""
    @State private var speechModel = ""
    @State private var models = VoiceModels(models: [], transcribe: [], speech: [])

    init(provider: VoiceProvider, key: VoiceKeyModel) {
        self.provider = provider
        self.key = key
        _mode = AppStorage(wrappedValue: "realtime", VoiceSettings.modeKey(provider))
    }

    private var speechMode: Bool { mode == "speech" }
    private var hasKey: Bool { key.hasKey }

    var body: some View {
        CardSection("\(provider.name) models", footer: hasKey ? nil : "Add a key to choose from \(provider.name)'s models.") {
            Group {
                if speechMode {
                    ValueRow("Speech to text") { picker($transcribeModel, models.transcribe) }
                    ValueRow("Text to speech") { picker($speechModel, models.speech) }
                } else {
                    ValueRow("Model") { picker($model, models.models) }
                }
                ValueRow("Voice") { ChoicePicker(selection: $voice, options: provider.voices.map { ($0, $0) }) }
                ValueRow("This month", value: "≈ \(VoiceUsage.minutes(for: provider)) min")
            }
            .disabled(!hasKey)
            .opacity(hasKey ? 1 : 0.55)
        }
        .task(id: hasKey) { await load() }
        .onChange(of: voice) { _, v in UserDefaults.standard.set(v, forKey: VoiceSettings.voiceKey(provider)) }
        .onChange(of: model) { _, m in VoiceSettings.save(m, default: VoiceSettings.defaults(provider).realtime, forKey: VoiceSettings.modelKey(provider)) }
        .onChange(of: transcribeModel) { _, m in
            VoiceSettings.save(m, default: VoiceSettings.defaults(provider).transcribe, forKey: VoiceSettings.transcribeKey(provider))
        }
        .onChange(of: speechModel) { _, m in
            VoiceSettings.save(m, default: VoiceSettings.defaults(provider).speech, forKey: VoiceSettings.speechKey(provider))
        }
    }

    private func picker(_ selection: Binding<String>, _ list: [String]) -> some View {
        // The current choice stays listed before the provider's list arrives.
        let options = list.contains(selection.wrappedValue) ? list : [selection.wrappedValue] + list
        return ChoicePicker(selection: selection, options: options.map { ($0, $0) })
    }

    private func load() async {
        voice = VoiceSettings.voice(provider)
        model = VoiceSettings.model(provider)
        transcribeModel = VoiceSettings.transcribeModel(provider)
        speechModel = VoiceSettings.speechModel(provider)
        if let data = UserDefaults.standard.data(forKey: VoiceSettings.modelsKey(provider)),
           let cached = try? JSONDecoder().decode(VoiceModels.self, from: data) {
            models = cached
        }
        guard hasKey, let client = store.client, let list = try? await client.voiceModels(provider) else { return }
        models = list
        // A newer default moves every choice the user hasn't made themselves.
        VoiceSettings.remember(list.defaults, for: provider)
        model = VoiceSettings.model(provider)
        transcribeModel = VoiceSettings.transcribeModel(provider)
        speechModel = VoiceSettings.speechModel(provider)
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: VoiceSettings.modelsKey(provider))
    }
}
