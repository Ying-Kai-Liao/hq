import CodyncKit
import SwiftUI

/// "2 min ago", "3 h ago", "4 d ago", or the date.
func kithAgo(_ date: Date, now: Date = .now) -> String {
    let s = max(0, now.timeIntervalSince(date))
    switch s {
    case ..<60: return "just now"
    case ..<3600: return "\(Int(s / 60)) min ago"
    case ..<86_400: return "\(Int(s / 3600)) h ago"
    case ..<(86_400 * 30): return "\(Int(s / 86_400)) d ago"
    default: return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}

func kithBytes(_ n: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
}

/// The caption under a kith bot's name: `kith · house` and the package chip. Long-press for where the package comes from.
struct KithIdentityLine: View {
    let agent: String
    let store: KithInfoStore

    var body: some View {
        HStack(spacing: 6) {
            Text("kith · \(agent)")
            if let package = store.info?.package, let chip = package.chip {
                Text(chip)
                    .font(.caption.monospaced())
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Palette.surface, in: Capsule())
                    .contextMenu {
                        if let remote = package.remote { Text(remote) }
                        if package.dirty { Text("Uncommitted changes") }
                        if package.unpushed { Text("Not pushed") }
                        if let pinned = package.pinned { Text("Pinned to \(pinned)") }
                        Text("Package version \(package.version ?? chip)")
                    }
            }
        }
        .font(.footnote)
        .foregroundStyle(Palette.secondary)
    }
}

/// A titled outlined card, like the Computer switch above the routines.
private struct KithCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.text)
                .padding(.leading, 2)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 10) { content }
                .outlinedCard()
        }
    }
}

/// A part kith couldn't read: said quietly instead of showing nothing.
private struct KithUnreadable: View {
    let title: String
    let thing: String

    var body: some View {
        KithCard(title: title) {
            Text("Couldn't read \(thing)").font(.footnote).foregroundStyle(Palette.secondary)
        }
    }
}

/// A row that opens and closes: title, count, chevron.
private struct KithGroup<Content: View>: View {
    let title: String
    let count: Int
    @ViewBuilder var content: Content
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.layout) { open.toggle() }
            } label: {
                HStack {
                    Text(title).font(.system(size: 15, weight: .semibold))
                    Text("\(count)").foregroundStyle(Palette.secondary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(Palette.text)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { VStack(alignment: .leading, spacing: 12) { content } }
        }
        .outlinedCard()
    }
}

/// The Details page's kith sections, top to bottom (serve/docs/bot-info.md).
struct KithDetailsSections: View {
    let store: KithInfoStore

    var body: some View {
        switch store.phase {
        case .unavailable:
            EmptyView()
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading kith details…").foregroundStyle(Palette.secondary)
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
        case .loaded(let response):
            if let info = response.info {
                sections(info)
            } else if let error = response.error {
                banner(error)
            }
        }
    }

    private func banner(_ error: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Kith details unavailable: \(error)")
                .font(.footnote)
                .foregroundStyle(Palette.danger)
                .textSelection(.enabled)
            Button("Retry") { Task { await store.load(refresh: true) } }
                .buttonStyle(.plain)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.accent)
        }
        .outlinedCard()
    }

    @ViewBuilder private func sections(_ info: KithInfo) -> some View {
        VStack(alignment: .leading, spacing: 28) {
            about(info)
            notYours(info)
            cost(info)
            schedules(info)
            projects(info)
            model(info)
            capabilities(info)
        }
    }

    // MARK: about

    @ViewBuilder private func about(_ info: KithInfo) -> some View {
        if info.errors["role"] != nil {
            KithUnreadable(title: "About", thing: "the role")
        } else {
            let sections = (info.role?.sections ?? []).filter { !$0.isNotYours }
            if (info.description ?? "").isEmpty == false || !(info.role?.intro ?? "").isEmpty || !sections.isEmpty {
                KithCard(title: "About") {
                    if let text = info.description, !text.isEmpty {
                        Text(text).foregroundStyle(Palette.text).textSelection(.enabled)
                    }
                    if let intro = info.role?.intro, !intro.isEmpty { KithIntro(text: intro) }
                    ForEach(sections) { KithRoleRow(section: $0) }
                }
            }
        }
    }

    @ViewBuilder private func notYours(_ info: KithInfo) -> some View {
        if let section = info.role?.sections.first(where: \.isNotYours), info.errors["role"] == nil {
            KithCard(title: "Not this bot's job") {
                MarkdownText(section.text)
            }
        }
    }

    // MARK: cost

    @ViewBuilder private func cost(_ info: KithInfo) -> some View {
        if info.errors["cost"] != nil {
            KithUnreadable(title: "Cost", thing: "the cost")
        } else {
            KithCard(title: "Cost") {
                if let cost = info.cost {
                    let figures: [(String, Double)] = [("Today", cost.today), ("7 days", cost.week), ("30 days", cost.month), ("All", cost.all)]
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(figures, id: \.0) { label, usd in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(KithCost.format(usd)).font(.system(size: 17, weight: .semibold)).monospacedDigit()
                                Text(label).font(.caption).foregroundStyle(Palette.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .foregroundStyle(Palette.text)
                    Text("\(cost.requestsMonth) requests in 30 days").font(.footnote).foregroundStyle(Palette.secondary)
                    let top = cost.topModels
                    if !top.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(top, id: \.model) { entry in
                                HStack {
                                    Text(entry.model).lineLimit(1).truncationMode(.middle)
                                    Spacer(minLength: 8)
                                    Text("\(KithCost.format(entry.usd)) · \(Int((entry.share * 100).rounded()))%").monospacedDigit()
                                }
                                .font(.footnote)
                                .foregroundStyle(Palette.secondary)
                            }
                        }
                    }
                } else {
                    Text("No cost recorded yet").font(.footnote).foregroundStyle(Palette.secondary)
                }
            }
        }
    }

    // MARK: schedules and projects

    @ViewBuilder private func schedules(_ info: KithInfo) -> some View {
        if info.errors["schedules"] != nil {
            KithUnreadable(title: "Schedules", thing: "the schedules")
        } else if !info.schedules.isEmpty {
            KithCard(title: "Schedules") {
                ForEach(Array(info.schedules.enumerated()), id: \.offset) { index, job in
                    if index > 0 { Divider() }
                    KithScheduleRow(job: job)
                }
            }
        }
    }

    @ViewBuilder private func projects(_ info: KithInfo) -> some View {
        if info.errors["projects"] != nil {
            KithUnreadable(title: "Projects", thing: "the projects")
        } else if !info.projects.isEmpty {
            KithCard(title: "Projects") {
                ForEach(info.projects) { project in
                    HStack(alignment: .firstTextBaseline) {
                        Text(project.id).foregroundStyle(Palette.text).lineLimit(1)
                        Spacer(minLength: 8)
                        Text([project.files == 1 ? "1 file" : "\(project.files) files",
                              project.modified.map { kithAgo($0.date) }].compactMap { $0 }.joined(separator: " · "))
                            .font(.footnote)
                            .foregroundStyle(Palette.secondary)
                    }
                }
            }
        }
    }

    // MARK: model, capabilities

    @ViewBuilder private func model(_ info: KithInfo) -> some View {
        let rows: [(String, String?)] = [("Model", info.model), ("Effort", info.effort), ("Permission", info.permissionMode),
                                         ("Harness", info.harness), ("Read-only", "yes")]
        KithCard(title: "Model & permissions") {
            ForEach(rows.filter { $0.1 != nil }, id: \.0) { label, value in
                HStack {
                    Text(label).foregroundStyle(Palette.secondary)
                    Spacer(minLength: 8)
                    Text(value ?? "").foregroundStyle(Palette.text)
                }
                .font(.subheadline)
            }
            if info.errors["permission_mode"] != nil {
                Text("Couldn't read the permission mode").font(.footnote).foregroundStyle(Palette.secondary)
            }
            Text("Set in the agent's package").font(.footnote).foregroundStyle(Palette.secondary)
        }
    }

    @ViewBuilder private func capabilities(_ info: KithInfo) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            group("Skills", "skills", info, count: info.skills.count) {
                ForEach(info.skills) { skill in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(skill.name).font(.subheadline.weight(.medium)).foregroundStyle(Palette.text)
                            if skill.source != "package" {
                                Text(skill.source)
                                    .font(.caption2)
                                    .foregroundStyle(Palette.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(Palette.surface, in: Capsule())
                            }
                        }
                        if !skill.description.isEmpty {
                            Text(skill.description).font(.footnote).foregroundStyle(Palette.secondary)
                        }
                    }
                }
            }
            group("Tools", "tools", info, count: info.tools.count) {
                ForEach(Array(info.tools.enumerated()), id: \.offset) { _, tool in
                    Text(tool).font(.footnote.monospaced()).foregroundStyle(Palette.text)
                }
            }
            group("MCP servers", "mcp_servers", info, count: info.mcpServers.count) {
                ForEach(info.mcpServers) { server in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(server.name).font(.subheadline.weight(.medium)).foregroundStyle(Palette.text)
                            if let kind = server.kind { Text(kind).font(.caption).foregroundStyle(Palette.secondary) }
                        }
                        if let target = server.target {
                            Text(target).font(.footnote.monospaced()).foregroundStyle(Palette.secondary).lineLimit(2)
                        }
                    }
                }
            }
            group("Plugins", "plugins", info, count: info.plugins.count) {
                ForEach(info.plugins, id: \.self) { Text($0).font(.footnote.monospaced()).foregroundStyle(Palette.text) }
            }
        }
    }

    /// Hidden when empty, a quiet line when kith couldn't read it.
    @ViewBuilder private func group<Rows: View>(_ title: String, _ key: String, _ info: KithInfo, count: Int,
                                                @ViewBuilder rows: () -> Rows) -> some View {
        if info.errors[key] != nil {
            Text("Couldn't read \(title.lowercased())").font(.footnote).foregroundStyle(Palette.secondary)
                .outlinedCard()
        } else if count > 0 {
            KithGroup(title: title, count: count, content: rows)
        }
    }
}

/// The role's intro: four lines and "More".
private struct KithIntro: View {
    let text: String
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if open {
                MarkdownText(text)
            } else {
                Text(MarkdownText.inline(text)).lineLimit(4).foregroundStyle(Palette.text).textSelection(.enabled)
            }
            if text.count > 180 || text.contains("\n") {
                Button(open ? "Less" : "More") { withAnimation(Motion.layout) { open.toggle() } }
                    .buttonStyle(.plain)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.accent)
            }
        }
    }
}

/// A role section: title, and its markdown when opened.
private struct KithRoleRow: View {
    let section: KithRoleSection
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Button {
                withAnimation(Motion.layout) { open.toggle() }
            } label: {
                HStack {
                    Text(section.title).font(.subheadline.weight(.medium))
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(Palette.text)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { MarkdownText(section.text) }
        }
    }
}

/// One schedule: the task, when it runs, and how the last run went.
private struct KithScheduleRow: View {
    let job: KithSchedule
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(Motion.layout) { open.toggle() } } label: {
                Text(job.task)
                    .lineLimit(open ? nil : 1)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(Palette.text)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            HStack(spacing: 6) {
                Text(job.plainCron).monospacedDigit()
                if job.paused {
                    Text("Paused")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Palette.surface, in: Capsule())
                }
            }
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
            Text(status).font(.footnote).foregroundStyle(Palette.secondary)
        }
    }

    private var status: String {
        var parts: [String] = []
        if job.isRunning { parts.append("running") } else if let last = job.lastRun { parts.append("last run \(kithAgo(last.date))") } else { parts.append("never run") }
        if !job.paused, let next = job.nextRun, next.date > .now { parts.append("next in \(RelativeTime.until(next.date))") }
        return parts.joined(separator: " · ")
    }
}
