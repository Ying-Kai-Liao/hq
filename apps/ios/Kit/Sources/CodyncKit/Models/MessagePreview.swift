import Foundation

/// The roster's first nonempty line, matching desktop and terminal previews.
public enum MessagePreview {
    public static func text(_ text: String) -> String {
        let first = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        return String(first.drop { "#>-* ".contains($0) })
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
    }
}
