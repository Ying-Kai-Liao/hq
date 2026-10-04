import CodyncKit
import SwiftUI
import UIKit

// Codync's own controls. Never use the stock ones (Picker, .switch toggles,
// Form/List styling, confirmationDialog/alert, ProgressView, DisclosureGroup,
// .bordered buttons, swipeActions): build from these instead.
// Menus are the one exception on iOS: `DropdownMenu`/`ChoicePicker` open the system
// `Menu` and `.contextActions` the system `contextMenu`. A hand-built overlay anchored
// by global frame lands in the wrong place there (sheets, scroll views, the composer),
// so `.codyncMenu` is macOS-only.
// Anything with a background fill gets no border line.

// MARK: - Switch

/// On/off switch: label on the left, a flat capsule track on the right.
public struct CodyncSwitch: ToggleStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        SwitchBody(configuration: configuration)
    }

    private struct SwitchBody: View {
        let configuration: Configuration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            Button {
                withAnimation(Motion.reduced(Motion.hover, reduceMotion)) { configuration.isOn.toggle() }
            } label: {
                HStack(spacing: 12) {
                    configuration.label
                    Spacer(minLength: 0)
                    Capsule()
                        .fill(configuration.isOn ? Palette.accentFill : Palette.bubbleUser)
                        .frame(width: 34, height: 20)
                        .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                            // Black and white: the knob takes the opposite ink of an on track.
                            Circle().fill(configuration.isOn ? Palette.onAccent : .white).padding(2)
                        }
                }
                .contentShape(Rectangle())
                .opacity(isEnabled ? 1 : 0.4)
            }
            .buttonStyle(.plain)
            .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
        }
    }
}

public extension ToggleStyle where Self == CodyncSwitch {
    static var codync: CodyncSwitch { CodyncSwitch() }
}

// MARK: - Buttons

/// The filled call-to-action: accent capsule with press feedback.
public struct PrimaryButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        StyledButton(configuration: configuration, fill: Palette.accentFill, foreground: Palette.onAccent)
    }
}

/// A quieter filled button next to a primary one.
public struct SecondaryButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        StyledButton(configuration: configuration, fill: Palette.bubbleUser, foreground: Palette.text)
    }
}

private struct StyledButton: View {
    let configuration: ButtonStyleConfiguration
    let fill: Color
    let foreground: Color
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .appFont(AppFont.compactBody.weight(.medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, InterfaceMetrics.value(mac: 12, mobile: 18))
            .padding(.vertical, InterfaceMetrics.value(mac: 6, mobile: 11))
            .background(fill, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? Motion.pressScale : 1)
            .animation(Motion.press, value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

public extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

public extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

// MARK: - Spinner

/// Loading indicator: a thin arc that turns.
public struct Spinner: View {
    var size: CGFloat
    @State private var turning = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat = 14) { self.size = size }

    public var body: some View {
        Circle()
            .trim(from: 0, to: 0.7)
            .stroke(Palette.secondary, style: StrokeStyle(lineWidth: max(1.5, size / 9), lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(turning ? 360 : 0))
            .animation(reduceMotion ? nil : .linear(duration: 0.8).repeatForever(autoreverses: false), value: turning)
            .onAppear { turning = true }
            .accessibilityLabel("Loading")
    }
}

// MARK: - Menus

/// One row in a Codync menu: an action, or a choice when `selected` is set.
public struct MenuItem: Identifiable {
    public let id = UUID()
    public var title: String
    public var icon: String?
    public var selected: Bool?
    public var destructive: Bool
    public var divider: Bool
    public var action: () -> Void

    public init(_ title: String, icon: String? = nil, selected: Bool? = nil, destructive: Bool = false,
                divider: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.selected = selected
        self.destructive = destructive
        self.divider = divider
        self.action = action
    }
}

/// A row of emoji above a message's menu (Slack's quick reactions).
public struct ReactionPick {
    public var emoji: [String]
    public var chosen: [String]
    public var toggle: (String) -> Void

    public init(emoji: [String], chosen: [String], toggle: @escaping (String) -> Void) {
        self.emoji = emoji
        self.chosen = chosen
        self.toggle = toggle
    }
}

private struct MenuAvailableSizeKey: EnvironmentKey {
    static let defaultValue = CGSize(width: 320, height: 420)
}

private extension EnvironmentValues {
    var menuAvailableSize: CGSize {
        get { self[MenuAvailableSizeKey.self] }
        set { self[MenuAvailableSizeKey.self] = newValue }
    }
}

/// The floating panel of menu rows (used by every menu, popover or overlay).
public struct MenuPanel: View {
    let items: [MenuItem]
    var reactions: ReactionPick?
    let dismiss: () -> Void
    @Environment(\.menuAvailableSize) private var availableSize
    @State private var contentHeight: CGFloat?
    @State private var positionedSelection = false

    public init(items: [MenuItem], reactions: ReactionPick? = nil, dismiss: @escaping () -> Void) {
        self.items = items
        self.reactions = reactions
        self.dismiss = dismiss
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 2) {
                    if let reactions {
                        ReactionStrip(pick: reactions, dismiss: dismiss)
                            .padding(.bottom, 4)
                    }
                    ForEach(items) { item in
                        if item.divider {
                            Rectangle().fill(Palette.text.opacity(0.1)).frame(height: 0.5)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                        }
                        MenuRow(item: item) {
                            dismiss()
                            item.action()
                        }
                        .id(item.id)
                    }
                }
                .padding(6)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(width: min(320, availableSize.width),
                   height: min(contentHeight ?? estimatedHeight, availableSize.height))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .onChange(of: contentHeight) { _, height in
                guard height != nil, !positionedSelection,
                      let selected = items.first(where: { $0.selected == true }) else { return }
                positionedSelection = true
                proxy.scrollTo(selected.id, anchor: .center)
            }
        }
    }

    private var estimatedHeight: CGFloat {
        CGFloat(items.count) * InterfaceMetrics.value(mac: 32, mobile: 46) + 12
            + (reactions == nil ? 0 : InterfaceMetrics.value(mac: 32, mobile: 46))
    }

}

/// Quick-reaction buttons; a chosen one is highlighted and tapping it takes it back.
struct ReactionStrip: View {
    let pick: ReactionPick
    var dismiss: () -> Void = {}

    var body: some View {
        HStack(spacing: 0) {
            ForEach(pick.emoji, id: \.self) { emoji in
                let chosen = pick.chosen.contains(emoji)
                Button {
                    dismiss()
                    pick.toggle(emoji)
                } label: {
                    Text(emoji).appFont(.system(size: InterfaceMetrics.value(mac: 14, mobile: 24)))
                }
                .buttonStyle(ReactionButtonStyle(chosen: chosen))
                .help(chosen ? "Remove \(emoji)" : "React \(emoji)")
                .accessibilityLabel(chosen ? "Remove reaction \(emoji)" : "React \(emoji)")
            }
        }
    }
}

/// One emoji in a reaction row: grows a little under the pointer, tinted once chosen.
private struct ReactionButtonStyle: ButtonStyle {
    let chosen: Bool

    func makeBody(configuration: Configuration) -> some View {
        ReactionButton(configuration: configuration, chosen: chosen)
    }

    private struct ReactionButton: View {
        let configuration: Configuration
        let chosen: Bool
        @State private var hovering = false

        var body: some View {
            let size = InterfaceMetrics.value(mac: 26, mobile: 40)
            configuration.label
                .scaleEffect(configuration.isPressed ? 0.85 : hovering ? 1.15 : 1)
                .frame(width: size, height: size)
                .background(
                    Palette.text.opacity(chosen ? 0.12 : hovering ? 0.06 : 0),
                    in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                )
                .contentShape(Rectangle())
                .animation(Motion.press, value: configuration.isPressed)
                .animation(Motion.hover, value: hovering)
                .onHover { hovering = $0 }
        }
    }
}

private struct MenuRow: View {
    let item: MenuItem
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icon = item.icon {
                    Image(systemName: icon).frame(width: 18)
                }
                // Wraps rather than truncates: a cut-off choice can't be read.
                Text(item.title).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 16)
                if let selected = item.selected {
                    Image(systemName: "checkmark").appFont(.caption.weight(.semibold)).opacity(selected ? 1 : 0)
                }
            }
            .appFont(AppFont.compactBody)
            .foregroundStyle(item.destructive ? Palette.danger : Palette.text)
            .padding(.horizontal, 10)
            .padding(.vertical, InterfaceMetrics.value(mac: 6, mobile: 11))
            .background(hovering ? Palette.text.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(Motion.hover) { hovering = h } }
        .help(item.title)
        .accessibilityAddTraits(item.selected == true ? .isSelected : [])
    }
}

public extension View {
    /// Mac only: shows a Codync menu under (or above) this view while `isPresented` is true.
    /// iOS menus are the system ones (`DropdownMenu`, `.contextActions`).
    @available(iOS, unavailable, message: "iOS menus are the system Menu: use DropdownMenu")
    func codyncMenu(isPresented: Binding<Bool>, items: @escaping () -> [MenuItem]) -> some View {
        modifier(AnchoredMenu(isPresented: isPresented, point: nil, items: items))
    }

    /// Right-click (Mac) opens a Codync menu; long-press (iPhone) the system context menu.
    /// `reactions` puts a quick-reaction row on top.
    func contextActions(reactions: ReactionPick? = nil, _ items: @escaping () -> [MenuItem]) -> some View {
        modifier(ContextActions(items: items, reactions: reactions))
    }
}

private struct ContextActions: ViewModifier {
    let items: () -> [MenuItem]
    let reactions: ReactionPick?

    func body(content: Content) -> some View {
        content.contextMenu {
            if let reactions {
                ControlGroup {
                    ForEach(reactions.emoji, id: \.self) { emoji in
                        let chosen = reactions.chosen.contains(emoji)
                        Toggle(isOn: Binding(get: { chosen }, set: { _ in reactions.toggle(emoji) })) { Text(emoji) }
                    }
                }
                .controlGroupStyle(.palette)
            }
            ForEach(items()) { item in
                if item.divider { Divider() }
                systemMenuRow(item)
            }
        }
    }
}

/// A `MenuItem` inside a system `Menu` or `contextMenu`: choices as checkmarked toggles.
@ViewBuilder private func systemMenuRow(_ item: MenuItem) -> some View {
    let role: ButtonRole? = item.destructive ? .destructive : nil
    if let selected = item.selected {
        Toggle(isOn: Binding(get: { selected }, set: { _ in item.action() })) {
            if let icon = item.icon { SwiftUI.Label(item.title, systemImage: icon) } else { Text(item.title) }
        }
    } else if let icon = item.icon {
        Button(role: role, action: item.action) { SwiftUI.Label(item.title, systemImage: icon) }
    } else {
        Button(item.title, role: role, action: item.action)
    }
}

/// Presents `MenuPanel` next to the view (or at `point` inside it, for right-clicks).
private struct AnchoredMenu: ViewModifier {
    @Binding var isPresented: Bool
    let point: CGPoint?
    let items: () -> [MenuItem]
    var reactions: ReactionPick?
    @State private var frame: CGRect = .zero

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
            .codyncOverlay(isPresented: $isPresented) { close in
                let anchor = point.map { CGRect(x: frame.minX + $0.x, y: frame.minY + $0.y, width: 0, height: 0) } ?? frame
                AnchoredPanel(anchor: anchor, close: close) {
                    MenuPanel(items: items(), reactions: reactions, dismiss: close)
                }
            }
    }
}

/// Places a floating panel beside `anchor` (global coordinates), flipping to stay on screen;
/// a tap anywhere else closes it.
struct AnchoredPanel<Panel: View>: View {
    let anchor: CGRect
    let close: () -> Void
    @ViewBuilder let panel: () -> Panel

    var body: some View {
        GeometryReader { geo in
            let space = geo.frame(in: .global)
            let a = anchor.offsetBy(dx: -space.minX, dy: -space.minY)
            let roomBelow = max(0, space.height - a.maxY - 14)
            let roomAbove = max(0, a.minY - 14)
            let below = roomBelow >= roomAbove
            let leading = a.midX < space.width * 0.6
            let horizontalInset = max(8, space.width - min(320, space.width - 16) - 8)
            ZStack(alignment: Alignment(horizontal: leading ? .leading : .trailing, vertical: below ? .top : .bottom)) {
                Color.clear.contentShape(Rectangle()).onTapGesture(perform: close)
                panel()
                    .environment(\.menuAvailableSize, CGSize(
                        width: max(1, space.width - 16),
                        height: max(1, min(420, below ? roomBelow : roomAbove))
                    ))
                    .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .shadow(color: .black.opacity(0.25), radius: 20, y: 8)
                    .offset(x: leading ? min(max(8, a.minX), horizontalInset) : -min(max(8, space.width - a.maxX), horizontalInset),
                            y: below ? a.maxY + 6 : -(space.height - a.minY + 6))
            }
        }
        .ignoresSafeArea()
    }
}

/// A button that opens a Codync menu.
public struct DropdownMenu<Label: View>: View {
    let items: () -> [MenuItem]
    let label: Label
    @State private var open = false

    public init(items: @escaping () -> [MenuItem], @ViewBuilder label: () -> Label) {
        self.items = items
        self.label = label()
    }

    public var body: some View {
        // The system menu: it anchors correctly inside sheets and scroll views, where an overlay can't.
        Menu {
            ForEach(items()) { item in
                if item.divider { Divider() }
                systemMenuRow(item)
            }
        } label: { label }
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
    }
}

/// Picks one value: shows the current choice in a pill with a chevron, opens a Codync menu.
public struct ChoicePicker<ID: Hashable>: View {
    @Binding var selection: ID
    let options: [(id: ID, label: String)]
    var fill: Color
    var fitsAvailableWidth: Bool

    public init(selection: Binding<ID>, options: [(id: ID, label: String)], fill: Color = .clear, fitsAvailableWidth: Bool = false) {
        _selection = selection
        self.options = options
        self.fill = fill
        self.fitsAvailableWidth = fitsAvailableWidth
    }

    public var body: some View {
        DropdownMenu {
            options.map { option in MenuItem(option.label, selected: option.id == selection) { selection = option.id } }
        } label: {
            HStack(spacing: 6) {
                Text(options.first { $0.id == selection }?.label ?? "Choose").lineLimit(1)
                Image(systemName: "chevron.down").appFont(.caption2.weight(.semibold)).foregroundStyle(Palette.secondary)
            }
            .appFont(AppFont.compactBody)
            .foregroundStyle(Palette.text)
            .pill(fill: fill)
            .overlay {
                if fill == .clear { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border) }
            }
        }
        .fixedSize(horizontal: !fitsAvailableWidth, vertical: true)
        .help(options.first { $0.id == selection }?.label ?? "Choose")
    }
}

/// Picks one of a few values side by side: the replacement for `.segmented`.
public struct SegmentedChoice<ID: Hashable>: View {
    @Binding var selection: ID
    let options: [(id: ID, label: String)]
    @Namespace private var thumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(selection: Binding<ID>, options: [(id: ID, label: String)]) {
        _selection = selection
        self.options = options
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.id) { option in
                let on = option.id == selection
                Button {
                    withAnimation(Motion.reduced(Motion.morph, reduceMotion)) { selection = option.id }
                } label: {
                    Text(option.label)
                        .appFont(AppFont.compactSecondary.weight(.medium))
                        .foregroundStyle(on ? Palette.text : Palette.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, InterfaceMetrics.value(mac: 5, mobile: 8))
                        .background {
                            if on {
                                Capsule().fill(Palette.background).matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Palette.bubbleUser, in: Capsule())
    }
}

/// A list of choices, one per row with a checkmark: the replacement for `.inline` pickers.
public struct ChoiceList<ID: Hashable>: View {
    @Binding var selection: ID
    let options: [(id: ID, label: String, detail: String?)]

    public init(selection: Binding<ID>, options: [(id: ID, label: String, detail: String?)]) {
        _selection = selection
        self.options = options
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: InterfaceMetrics.value(mac: 10, mobile: 14)) {
            ForEach(options, id: \.id) { option in
                Button { selection = option.id } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).foregroundStyle(Palette.text)
                            if let detail = option.detail, !detail.isEmpty {
                                Text(detail).appFont(AppFont.compactSecondary).foregroundStyle(Palette.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "checkmark")
                            .appFont(.caption.weight(.semibold))
                            .foregroundStyle(Palette.text)
                            .opacity(option.id == selection ? 1 : 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(option.id == selection ? .isSelected : [])
            }
        }
    }
}

// MARK: - Forms

/// A scrolling page of cards: the replacement for `Form` / grouped `List`.
public struct CardForm<Content: View>: View {
    let content: Content

    public init(@ViewBuilder content: () -> Content) { self.content = content() }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: InterfaceMetrics.value(mac: 28, mobile: 32)) {
                content
            }
            .appFont(AppFont.compactBody)
            .padding(InterfaceMetrics.value(mac: 14, mobile: 20))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
    }
}

/// A titled group of rows: the replacement for `Section`. Modeled on ChatGPT's desktop settings:
/// a small bold heading over a filled, rounded group whose rows are split by inset hairlines
/// (references in `docs/design/reference/`).
public struct CardSection<Content: View, Accessory: View>: View {
    let title: String?
    let footer: String?
    let content: Content
    /// Trailing controls on the heading's line (add, refresh, clear).
    let accessory: Accessory

    public init(_ title: String? = nil, footer: String? = nil, @ViewBuilder content: () -> Content,
                @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.footer = footer
        self.content = content()
        self.accessory = accessory()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: InterfaceMetrics.value(mac: 10, mobile: 10)) {
            if let title {
                HStack(spacing: 8) {
                    Text(title)
                        .appFont(.system(size: InterfaceMetrics.value(mac: 13, mobile: 15), weight: .semibold))
                        .foregroundStyle(Palette.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    accessory
                }
                .padding(.leading, 2)
            }
            VStack(alignment: .leading, spacing: 0) {
                _VariadicView.Tree(HairlineRows()) { content }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            if let footer {
                Text(footer)
                    .appFont(.caption)
                    .foregroundStyle(Palette.secondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

public extension CardSection where Accessory == EmptyView {
    init(_ title: String? = nil, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title, footer: footer, content: content) { EmptyView() }
    }
}

/// A 1-pixel separator line in the border color.
public struct Hairline: View {
    @Environment(\.displayScale) private var scale

    public init() {}

    public var body: some View {
        Rectangle().fill(Palette.border).frame(height: 1 / scale)
    }
}

/// Lays a section's rows out one under another with an inset hairline between each pair.
private struct HairlineRows: _VariadicView_MultiViewRoot {
    func body(children: _VariadicView.Children) -> some View {
        let inset = InterfaceMetrics.value(mac: 16, mobile: 16)
        ForEach(children) { child in
            child
                .frame(maxWidth: .infinity, minHeight: InterfaceMetrics.value(mac: 28, mobile: 32), alignment: .leading)
                .padding(.horizontal, inset)
                .padding(.vertical, InterfaceMetrics.value(mac: 12, mobile: 14))
            if child.id != children.last?.id { Hairline().padding(.horizontal, inset) }
        }
    }
}

/// Label on the left, value on the right: the replacement for `LabeledContent`.
public struct ValueRow<Value: View>: View {
    let label: String
    let detail: String?
    let value: Value

    public init(_ label: String, detail: String? = nil, @ViewBuilder value: () -> Value) {
        self.label = label
        self.detail = detail
        self.value = value()
    }

    public init(_ label: String, detail: String? = nil, value: String) where Value == Text {
        self.label = label
        self.detail = detail
        self.value = Text(value)
    }

    public var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).foregroundStyle(Palette.text)
                if let detail {
                    Text(detail)
                        .appFont(.caption)
                        .foregroundStyle(Palette.secondary)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            value.foregroundStyle(Palette.secondary)
        }
    }
}

/// A search box: the replacement for `.searchable`.
public struct SearchField: View {
    let prompt: String
    @Binding var text: String

    public init(_ prompt: String = "Search", text: Binding<String>) {
        self.prompt = prompt
        _text = text
    }

    public var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.secondary)
            TextField(prompt, text: $text).textFieldStyle(.plain).plainTextInput()
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .appFont(AppFont.compactBody)
        .padding(.horizontal, InterfaceMetrics.value(mac: 10, mobile: 14))
        .padding(.vertical, InterfaceMetrics.value(mac: 7, mobile: 10))
        .background(Palette.bubbleAgent, in: Capsule())
    }
}

/// A row that expands to show more: the replacement for `DisclosureGroup`.
public struct Disclosure<Label: View, Content: View>: View {
    @Binding var isExpanded: Bool
    let label: Label
    let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(isExpanded: Binding<Bool>, @ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {
        _isExpanded = isExpanded
        self.content = content()
        self.label = label()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(Motion.reduced(Motion.layout, reduceMotion)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    label
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .appFont(.caption2.weight(.semibold))
                        .foregroundStyle(Palette.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            if isExpanded { content }
        }
    }
}

// MARK: - Dialogs

/// A button in a Codync dialog.
public struct DialogAction: Identifiable {
    public let id = UUID()
    public var title: String
    public var destructive: Bool
    public var action: () -> Void

    public init(_ title: String, destructive: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.destructive = destructive
        self.action = action
    }
}

public extension View {
    /// A centered card over a dimmed screen with the actions and Cancel:
    /// the replacement for `confirmationDialog` and `alert`.
    /// Set `inPlace` only at the navigation root to keep underlying glass unchanged.
    func codyncDialog(_ title: String, isPresented: Binding<Bool>, message: String? = nil,
                      cancel: String? = "Cancel", inPlace: Bool = false,
                      actions: @escaping () -> [DialogAction]) -> some View {
        modifier(CodyncDialog(title: title, message: message, cancel: cancel, inPlace: inPlace,
                              isPresented: isPresented, actions: actions))
    }
}

private struct CodyncDialog: ViewModifier {
    let title: String
    let message: String?
    let cancel: String?
    /// Use only above the navigation container so the scrim also covers its toolbar.
    let inPlace: Bool
    @Binding var isPresented: Bool
    let actions: () -> [DialogAction]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if inPlace {
            content
                .allowsHitTesting(!isPresented)
                .accessibilityHidden(isPresented)
                .overlay {
                    if isPresented {
                        DialogCard(title: title, message: message, cancel: cancel, actions: actions()) {
                            isPresented = false
                        }
                        .transition(.opacity)
                        .onAppear {
                            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                             to: nil, from: nil, for: nil)
                        }
                    }
                }
                .animation(Motion.reduced(Motion.fade, reduceMotion), value: isPresented)
        } else {
            content.codyncOverlay(isPresented: $isPresented) { close in
                DialogCard(title: title, message: message, cancel: cancel, actions: actions(), dismiss: close)
            }
        }
    }
}

private struct DialogCard: View {
    let title: String
    let message: String?
    let cancel: String?
    let actions: [DialogAction]
    let dismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
                .onTapGesture { if cancel != nil { dismiss() } }
            VStack(spacing: 14) {
                VStack(spacing: 6) {
                    Text(title).appFont(.headline).foregroundStyle(Palette.text)
                    if let message, !message.isEmpty {
                        Text(message).appFont(AppFont.compactSecondary).foregroundStyle(Palette.secondary)
                    }
                }
                .multilineTextAlignment(.center)
                VStack(spacing: 8) {
                    ForEach(actions) { action in
                        Button {
                            dismiss()
                            action.action()
                        } label: {
                            Text(action.title).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(DialogButtonStyle(destructive: action.destructive, prominent: true))
                    }
                    if let cancel {
                        Button(action: dismiss) { Text(cancel).frame(maxWidth: .infinity) }
                            .buttonStyle(DialogButtonStyle(destructive: false, prominent: false))
                            .keyboardShortcut(.cancelAction)
                    }
                }
            }
            .padding(18)
            .frame(maxWidth: 320)
            .background(Palette.bubbleAgent, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: 24, y: 10)
            .padding(24)
        }
        .accessibilityAddTraits(.isModal)
    }
}

private struct DialogButtonStyle: ButtonStyle {
    let destructive: Bool
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .appFont(AppFont.compactBody.weight(.medium))
            .foregroundStyle(destructive ? Color.white : (prominent ? Palette.onAccent : Palette.text))
            .padding(.vertical, InterfaceMetrics.value(mac: 8, mobile: 12))
            .background(destructive ? Palette.danger : (prominent ? Palette.accentFill : Palette.bubbleUser), in: Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? Motion.pressScale : 1)
            .animation(Motion.press, value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

// MARK: - Shared bits

extension View {
    /// The value pill: a filled rounded box, no border.
    /// A value in an outlined pill, like ChatGPT's settings dropdowns (outline or fill, never both).
    func outlinedPill() -> some View {
        pill(fill: .clear)
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border))
    }

    func pill(fill: Color = Palette.background) -> some View {
        padding(.horizontal, InterfaceMetrics.value(mac: 9, mobile: 12))
            .padding(.vertical, InterfaceMetrics.value(mac: 5, mobile: 7))
            .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

