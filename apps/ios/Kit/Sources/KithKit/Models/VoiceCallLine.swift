import Foundation

/// The tail of a "Voice chat" notice: " · 00:16" once the call is over, " · in progress" while it may still
/// be going. A line that never got its length (the app was killed mid call) shows nothing after "Voice chat"
/// once it is older than `liveHours`, rather than "in progress" forever.
public enum VoiceCallLine {
    public static let liveHours = 3.0

    /// nil when `data` isn't a voice call line.
    public static func suffix(_ data: EntryData, at date: Date, now: Date = .now) -> String? {
        if let seconds = data.callSeconds {
            return " · " + String(format: "%02d:%02d", seconds / 60, seconds % 60)
        }
        guard data.callLive == true else { return nil }
        return now.timeIntervalSince(date) < liveHours * 3600 ? " · in progress" : ""
    }
}
