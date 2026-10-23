import KithKit
import SwiftUI

/// Says which side has to update before this app and a computer can work together. Shown instead of the
/// composer and above the computer's bots (docs/reference/compatibility.md).
public struct UpdateNeededCard: View {
    let store: BotStore
    let mismatch: VersionMismatch

    public init(store: BotStore, mismatch: VersionMismatch) {
        self.store = store
        self.mismatch = mismatch
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "arrow.down.circle")
                .font(.title3)
                .foregroundStyle(Palette.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    var title: String { UpdateNeededText.title(mismatch, host: store.hostName) }
    var detail: String {
        UpdateNeededText.detail(mismatch, host: store.hostName, hostVersion: store.hostVersion?.version,
                                os: store.hello?.os)
    }
}

/// The words every client uses for a version mismatch (the desktop app and the terminal client
/// mirror them).
public enum UpdateNeededText {
    public static func title(_ mismatch: VersionMismatch, host: String) -> String {
        switch mismatch {
        case .updateApp: "Update this app"
        case .updateHost: "Update Kith on \(host)"
        }
    }

    public static func detail(_ mismatch: VersionMismatch, host: String, hostVersion: String?, os: String?,
                              instructions: Bool = true) -> String {
        switch mismatch {
        case let .updateApp(minimum):
            let runs = hostVersion.map { "\(host) runs Kith \($0) and" } ?? host
            return "\(runs) needs this app to be \(minimum) or newer. Your chats are safe on the computer."
        case let .updateHost(version, minimum):
            let how = switch os {
            case "macos": "Pull the latest hq on that Mac and run kith serve start there."
            default: "Update Kith on that computer."
            }
            let needs = "\(host) runs Kith \(version); this app needs \(minimum) or newer."
            return instructions ? "\(needs) \(how)" : needs
        }
    }
}
