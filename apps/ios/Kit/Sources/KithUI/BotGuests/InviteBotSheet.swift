import KithKit
import SwiftUI
import UIKit

/// Invite a bot from outside (Grok or another app): its name, where it is from and the agents it may ask, then the host's
/// text to paste into the bot. Nothing is ticked unless the caller presets it (the Share sheet ticks its agent).
public struct InviteBotSheet: View {
    /// A finished invite shown straight away: "New link" for a bot already there.
    public struct Result: Equatable {
        public var invite: CreatedBotInvite
        public var name: String
        public var provider: String

        public init(invite: CreatedBotInvite, name: String, provider: String) {
            self.invite = invite
            self.name = name
            self.provider = provider
        }
    }

    let store: BotStore
    @Environment(\.dismissModal) private var dismiss
    @State private var name = ""
    @State private var provider = "grok"
    @State private var ticked: Set<String>
    @State private var created: Result?
    @State private var copied = false

    public init(store: BotStore, preset: Set<String> = [], result: Result? = nil) {
        self.store = store
        _ticked = State(initialValue: preset)
        _created = State(initialValue: result)
    }

    private var guests: BotGuestStore { store.botGuests }
    private var invitee: Bool { !store.isOwner }
    private var choices: [(agent: String, title: String)] { store.botAgentChoices }
    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canCreate: Bool { !trimmed.isEmpty && !ticked.isEmpty && !guests.busy }

    public var body: some View {
        Group {
            if let created { resultView(created) } else { form }
        }
        .background(Palette.background)
        .safeAreaInset(edge: .top, spacing: 0) {
            ModalHeader(title: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(created == nil ? "Invite a bot" : "Invite ready")
                    if let created {
                        Text("\(created.name) · \(BotGuest.title(provider: created.provider))")
                            .font(.caption).fontWeight(.regular).foregroundStyle(Palette.secondary)
                    } else if invitee {
                        Text("On \(store.hostName)").font(.caption).fontWeight(.regular).foregroundStyle(Palette.secondary)
                    }
                }
            }, trailing: { EmptyView() })
        }
    }

    // MARK: form

    private var form: some View {
        CardForm {
            CardSection("Name", footer: "What it's called here.") {
                TextField("Rex", text: $name)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.done)
                    .onChange(of: name) { _, new in if new.count > 40 { name = String(new.prefix(40)) } }
            }
            CardSection("From") {
                SegmentedChoice(selection: $provider, options: [("grok", "Grok"), ("other", "Other")])
            }
            CardSection("What it can ask", footer: choices.isEmpty
                        ? "You don't have any agents to share here."
                        : "It gets guest access to what you tick, never more than you have.") {
                ForEach(choices, id: \.agent) { choice in
                    Toggle(isOn: Binding(get: { ticked.contains(choice.agent) },
                                         set: { if $0 { ticked.insert(choice.agent) } else { ticked.remove(choice.agent) } })) {
                        HStack(spacing: 10) {
                            if let room = store.bots.values.first(where: { $0.hqAgent == choice.agent }) {
                                CharacterAvatar(bot: room, size: 24, animated: false)
                            }
                            Text(choice.title)
                        }
                    }
                    .toggleStyle(.kith)
                }
            }
            if let error = guests.error {
                Text(error).font(.footnote).foregroundStyle(Palette.danger)
            }
            if invitee {
                Label("\(sentenceOwner) can see what this bot asks, and may need to allow it before it starts.",
                      systemImage: "eye")
                    .font(.footnote).foregroundStyle(Palette.muted)
            }
            Button {
                Task { await create() }
            } label: {
                ZStack {
                    Text("Create invite").opacity(guests.busy ? 0 : 1)
                    if guests.busy { Spinner(size: 18) }
                }
                .frame(maxWidth: .infinity, minHeight: 28)
            }
            .buttonStyle(.primary)
            .disabled(!canCreate)
            .accessibilityLabel(guests.busy ? "Creating" : "Create invite")
        }
    }

    private var sentenceOwner: String { BotGuestRowModel.sentenceCase(store.ownerCalled) }

    /// Not safe to repeat: the button is off while the call runs, and the store ignores a second one.
    private func create() async {
        let agents = choices.map(\.agent).filter { ticked.contains($0) }
        guard let made = await guests.createInvite(name: trimmed, provider: provider, agents: agents) else { return }
        created = Result(invite: made, name: trimmed, provider: provider)
    }

    // MARK: result

    private func resultView(_ result: Result) -> some View {
        let title = BotGuest.title(provider: result.provider)
        let share = result.invite.share
        return CardForm {
            Text(result.provider == "grok" ? "Paste this into your chat with \(result.name) in \(title)."
                 : "Paste this into your chat with \(result.name).")
                .kithText(.body).foregroundStyle(Palette.text)
            // The host's words, as they are: the app never writes this text itself.
            ScrollView {
                Text(share)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(maxHeight: 8 * 18 + 24)
            .background(Palette.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(spacing: 10) {
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = share
                    copied = true
                }
                .buttonStyle(.primary)
                ShareLink(item: share) {
                    Label("Share…", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity, minHeight: 28)
                }
                .buttonStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                fact("Expires \(result.invite.expiry.formatted(.relative(presentation: .named)))", "clock")
                fact("Works once, for one bot", "link")
                fact("Anyone with this text can join as \(result.name). Send it only to your bot.", "lock.fill")
                if invitee { fact("\(sentenceOwner) can see what \(result.name) asks", "eye") }
            }
            Button("Done") { dismiss() }
                .buttonStyle(.secondary)
        }
    }

    private func fact(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol).font(.system(size: 13)).foregroundStyle(Palette.secondary)
    }
}
