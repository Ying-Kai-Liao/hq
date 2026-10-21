import Foundation

/// Presentation only; the ActivityKit payload and host push contract stay unchanged.
public struct BotActivityPresentation: Hashable, Sendable {
    public enum Phase: String, CaseIterable, Sendable {
        /// `sending` and `queued` are this phone's own (a message on its way, or waiting in the
        /// relay mailbox for an offline computer); the computer only pushes the others.
        case sending, queued, working, needsInput, completed, failed, stale, waiting
    }

    public let phase: Phase
    public let activity: String

    public init(status: String, activity: String, isStale: Bool = false) {
        let phase: Phase = switch status {
        case "sending": .sending
        case "queued": .queued
        case "working": .working
        case "needsInput": .needsInput
        case "idle", "completed": .completed
        case "error": .failed
        default: .waiting
        }
        self.phase = isStale && (phase == .working || phase == .needsInput || phase == .sending) ? .stale : phase
        self.activity = activity
    }

    public var title: String {
        switch phase {
        case .sending: "Sending"
        case .queued: "Waiting for your computer"
        case .working: "Working"
        case .needsInput: "Needs you"
        case .completed: "Done"
        case .failed: "Failed"
        case .stale: "Update delayed"
        case .waiting: "Waiting for update"
        }
    }

    /// The one line of text beside the orb: the bot's current step while it's live, else the state.
    public var caption: String {
        switch phase {
        case .working, .needsInput: activity.isEmpty ? title : activity
        case .sending, .queued, .completed, .failed, .stale, .waiting: title
        }
    }

    public var symbol: String {
        switch phase {
        case .completed: "checkmark"
        case .failed: "exclamationmark.triangle.fill"
        case .queued: "desktopcomputer"
        case .sending, .working, .needsInput, .stale, .waiting: "ellipsis"
        }
    }
}
