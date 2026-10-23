import CodyncKit
import SwiftUI

/// THIRD_PARTY_NOTICES.md, written by scripts/notices/generate.mjs, split for the screen. The format is fixed by
/// the generator: `## <license>` opens a group, `- name version (source)` a package with two-space-indented detail
/// lines under it, a ~~~~~ fence a license text. The desktop app parses the same file
/// (apps/desktop/src/shared/notices.ts): change both together.
struct ThirdPartyNotices: Equatable {
    struct Package: Equatable {
        var name: String
        var details: [String] = []
    }

    struct Group: Equatable {
        var license: String
        var packages: [Package] = []
        var texts: [String] = []
    }

    var intro = ""
    var groups: [Group] = []

    init(markdown: String) {
        var introLines: [String] = []
        var inText = false
        var text: [String] = []
        for raw in markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if inText {
                if line.hasPrefix("~~~~~") {
                    if !groups.isEmpty { groups[groups.count - 1].texts.append(text.joined(separator: "\n")) }
                    inText = false
                } else {
                    text.append(line)
                }
            } else if line.hasPrefix("~~~~~") {
                inText = true
                text = []
            } else if line.hasPrefix("## ") {
                groups.append(Group(license: String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)))
            } else if groups.isEmpty {
                if !line.hasPrefix("# ") && !line.hasPrefix("<!--") { introLines.append(line) }
            } else if line.hasPrefix("- ") {
                groups[groups.count - 1].packages.append(Package(name: String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)))
            } else if line.hasPrefix("  "), !groups[groups.count - 1].packages.isEmpty {
                groups[groups.count - 1].packages[groups[groups.count - 1].packages.count - 1].details
                    .append(line.trimmingCharacters(in: .whitespaces))
            }
        }
        intro = introLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The copy the app build puts in the bundle (apps/project.yml); nil when a build skipped it.
    static func bundled(_ bundle: Bundle = .main) -> ThirdPartyNotices? {
        guard let url = bundle.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "md"),
              let markdown = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return ThirdPartyNotices(markdown: markdown)
    }
}

/// Settings' "Open-source licenses" row: the generated third-party notices, one collapsible group per license.
public struct LicensesSheet: View {
    private let notices = ThirdPartyNotices.bundled()

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            ModalHeader("Open-source licenses")
            CardForm {
                if let notices {
                    Text(notices.intro)
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(notices.groups, id: \.license) { LicenseGroup(group: $0) }
                } else {
                    Text("The license notices are missing from this build.")
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                }
            }
        }
        .background(Palette.background)
    }
}

private struct LicenseGroup: View {
    let group: ThirdPartyNotices.Group
    @State private var open = false

    var body: some View {
        CardSection(group.license) {
            Button {
                open.toggle()
            } label: {
                Text("\(open ? "Hide" : "Show") \(group.packages.count) \(group.packages.count == 1 ? "package" : "packages")")
                    .foregroundStyle(Palette.text)
            }
            if open {
                ForEach(Array(group.packages.enumerated()), id: \.offset) { _, package in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(package.name)
                        ForEach(Array(package.details.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.footnote)
                                .foregroundStyle(Palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                ForEach(Array(group.texts.enumerated()), id: \.offset) { _, text in
                    Text(text)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Palette.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
