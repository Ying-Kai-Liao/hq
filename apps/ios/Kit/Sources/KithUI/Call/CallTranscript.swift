import Foundation

/// One caption line on the call screen.
struct CallCaption: Identifiable, Equatable {
    enum Speaker: Equatable { case you, bot }
    let id: Int
    let speaker: Speaker
    var text: String
}

/// What the call screen shows as captions: what you said, and the sentences the bot speaks, one
/// line per turn. Pure, so the assembly is testable without audio.
struct CallTranscript: Equatable {
    private(set) var lines: [CallCaption] = []
    private var next = 0
    /// Old lines scroll away; a call can run for an hour.
    static let limit = 60

    /// What you said, once it is sent: a line of its own.
    mutating func you(_ text: String) {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        append(.you, said)
    }

    /// A sentence the bot is about to speak: it joins the bot's line of this turn.
    mutating func bot(_ sentence: String) {
        let said = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        if let last = lines.last, last.speaker == .bot {
            lines[lines.count - 1].text += " " + said
        } else {
            append(.bot, said)
        }
    }

    private mutating func append(_ speaker: CallCaption.Speaker, _ text: String) {
        lines.append(CallCaption(id: next, speaker: speaker, text: text))
        next += 1
        if lines.count > Self.limit { lines.removeFirst(lines.count - Self.limit) }
    }
}

/// The state line under the bot's name.
enum CallStatus {
    static func text(phase: VoicePhase?, muted: Bool, working: Bool, warning: String?) -> String {
        switch phase {
        case .none, .starting?: warning ?? "Connecting…"
        case .speaking?: "Speaking"
        case .failed?: "Can't listen"
        case .listening? where muted: "Muted"
        case .listening?: warning ?? (working ? "Working…" : "Listening")
        }
    }

    /// 0:07, 12:03, 1:02:03.
    static func clock(_ seconds: Int) -> String {
        let s = max(0, seconds)
        let (h, m) = (s / 3600, s / 60 % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s % 60) : String(format: "%d:%02d", m, s % 60)
    }
}
