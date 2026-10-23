import CodyncKit
import SwiftUI

/// "via codex" under a reply a backup account answered. Nothing for the agent's own account and for older messages.
struct AnsweredByLabel: View {
    let answeredBy: String?

    var body: some View {
        if let label = backupViaLabel(answeredBy) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(Palette.tertiary)
                .accessibilityLabel("Answered by the backup \(answeredBy ?? "")")
        }
    }
}
