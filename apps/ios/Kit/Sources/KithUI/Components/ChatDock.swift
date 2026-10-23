import KithKit
import SwiftUI

/// What the dock shows for a given state. Pure, so it is tested.
public enum ChatDockLayout {
    /// Anything typed or attached counts as "writing".
    public static func isWriting(text: String, hasAttachment: Bool) -> Bool {
        hasAttachment || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The call button sits to the right of the box; it slides away while writing and comes back when cleared.
    /// `showsCall` is false where the call lives elsewhere (the agent chat has the phone at the top).
    public static func callVisible(showsCall: Bool, text: String, hasAttachment: Bool) -> Bool {
        showsCall && !isWriting(text: text, hasAttachment: hasAttachment)
    }

    /// Send arrow when there is something to send, mic otherwise.
    public static func showsSend(text: String, hasAttachment: Bool) -> Bool {
        isWriting(text: text, hasAttachment: hasAttachment)
    }
}

/// How the send button looks. Additive: Crew home greys the arrow while the typed words lead to a room and spells
/// out "Send" when nothing matches; chats keep `.ink`.
public enum ChatDockSendStyle: Sendable {
    case ink, muted, word
}

/// The chat box: a floating Liquid Glass pill (54 pt). `+` opens Photos / Camera / Files; a text field; mic when
/// empty, send when there is text; a round glass call button to its right that slides away while typing.
///
/// Binding-based, with no sending logic: the screen owns the text, sends, queues and dictates. `accessory` is a
/// slot above the field inside the pill for the composer's attachment strip, command list or router line later.
public struct ChatDock<Accessory: View>: View {
    @Binding var text: String
    let placeholder: String
    let showsCall: Bool
    let hasAttachment: Bool
    let onSend: () -> Void
    let onMic: () -> Void
    let onCall: () -> Void
    let onPhotos: () -> Void
    let onCamera: () -> Void
    let onFiles: () -> Void
    let sendStyle: ChatDockSendStyle
    let accessory: Accessory
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(text: Binding<String>, placeholder: String, showsCall: Bool = true, hasAttachment: Bool = false,
                onSend: @escaping () -> Void = {}, onMic: @escaping () -> Void = {}, onCall: @escaping () -> Void = {},
                onPhotos: @escaping () -> Void = {}, onCamera: @escaping () -> Void = {}, onFiles: @escaping () -> Void = {},
                sendStyle: ChatDockSendStyle = .ink, @ViewBuilder accessory: () -> Accessory) {
        _text = text
        self.placeholder = placeholder
        self.showsCall = showsCall
        self.hasAttachment = hasAttachment
        self.onSend = onSend
        self.onMic = onMic
        self.onCall = onCall
        self.onPhotos = onPhotos
        self.onCamera = onCamera
        self.onFiles = onFiles
        self.sendStyle = sendStyle
        self.accessory = accessory()
    }

    private var callVisible: Bool { ChatDockLayout.callVisible(showsCall: showsCall, text: text, hasAttachment: hasAttachment) }

    public var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            VStack(spacing: 0) {
                accessory
                HStack(spacing: 4) {
                    plusMenu
                    TextField(placeholder, text: $text, axis: .vertical)
                        .kithText(.body)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1...5)
                        .padding(.vertical, 8)
                    trailingButton
                }
                .padding(.horizontal, 5)
                .frame(minHeight: KithSize.chatBoxHeight)
            }
            .kithGlassPill()
            if callVisible {
                Button(action: onCall) {
                    Image(systemName: "phone.fill").font(.system(size: 18, weight: .medium)).foregroundStyle(Palette.ink)
                        .frame(width: KithSize.chatBoxHeight, height: KithSize.chatBoxHeight)
                        .kithGlass(in: Circle(), interactive: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Call"))
                .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(.horizontal, KithSpacing.gutter)
        .animation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0.1), value: callVisible)
    }

    private var plusMenu: some View {
        Menu {
            Button(action: onPhotos) { Label("Photos", systemImage: "photo") }
            Button(action: onCamera) { Label("Camera", systemImage: "camera") }
            Button(action: onFiles) { Label("Files", systemImage: "folder") }
        } label: {
            Image(systemName: "plus").font(.system(size: 18, weight: .medium)).foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
                .background(Palette.ink.opacity(0.06), in: Circle())
                .contentShape(Circle())
        }
        .accessibilityLabel(Text("Add"))
    }

    @ViewBuilder private var trailingButton: some View {
        if ChatDockLayout.showsSend(text: text, hasAttachment: hasAttachment) {
            Button(action: onSend) {
                switch sendStyle {
                case .word:
                    Text("Send").kithText(.body).fontWeight(.semibold).foregroundStyle(Palette.background)
                        .padding(.horizontal, 16).frame(minWidth: 44, minHeight: 44)
                        .background(Palette.ink, in: Capsule())
                        .contentShape(Capsule())
                default:
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(Palette.background)
                        .frame(width: 44, height: 44)
                        .background(sendStyle == .muted ? Palette.muted : Palette.ink, in: Circle())
                        .contentShape(Circle())
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Send"))
        } else {
            Button(action: onMic) {
                Image(systemName: "mic").font(.system(size: 18)).foregroundStyle(Palette.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Dictate"))
        }
    }
}

public extension ChatDock where Accessory == EmptyView {
    init(text: Binding<String>, placeholder: String, showsCall: Bool = true, hasAttachment: Bool = false,
         onSend: @escaping () -> Void = {}, onMic: @escaping () -> Void = {}, onCall: @escaping () -> Void = {},
         onPhotos: @escaping () -> Void = {}, onCamera: @escaping () -> Void = {}, onFiles: @escaping () -> Void = {},
         sendStyle: ChatDockSendStyle = .ink) {
        self.init(text: text, placeholder: placeholder, showsCall: showsCall, hasAttachment: hasAttachment, onSend: onSend,
                  onMic: onMic, onCall: onCall, onPhotos: onPhotos, onCamera: onCamera, onFiles: onFiles,
                  sendStyle: sendStyle) { EmptyView() }
    }
}

#Preview("Dock, empty") {
    ZStack(alignment: .bottom) {
        SkyBackground(.home, edgeToEdge: false)
        ChatDock(text: .constant(""), placeholder: "Find or ask…")
    }
    .frame(height: 200)
}

#Preview("Dock, typing") {
    ZStack(alignment: .bottom) {
        SkyBackground(.home, edgeToEdge: false)
        ChatDock(text: .constant("Why is the mini so slow?"), placeholder: "Find or ask…")
    }
    .frame(height: 200)
}

#Preview("Dock, agent chat, attachment") {
    ZStack(alignment: .bottom) {
        SkyBackground(.header, edgeToEdge: false)
        ChatDock(text: .constant(""), placeholder: "Tell coder…", showsCall: false, hasAttachment: true) {
            HStack { Label("screenshot.png", systemImage: "photo").kithText(.secondary); Spacer() }
                .padding(.horizontal, 14).padding(.top, 10)
        }
    }
    .frame(height: 200)
}
