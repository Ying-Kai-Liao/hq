import CodyncKit
import SwiftUI
import UIKit

/// One row of a conversation: a message, a separator, the working indicator…
struct ConversationRow {
    let id: String
    /// The reader's own new message: the list goes back down to it.
    var isUserMessage = false
    let content: AnyView

    init(_ id: String, isUserMessage: Bool = false, @ViewBuilder content: () -> some View) {
        self.id = id
        self.isUserMessage = isUserMessage
        self.content = AnyView(content())
    }
}

/// A conversation's scrolling list, in UIKit (a collection view of hosted SwiftUI rows): only
/// the rows on screen exist, and a changed row re-renders alone. It opens at the newest
/// message and follows it (`following`) as messages arrive and replies grow. Scrolling away
/// stops following, so the text being read stays put (rows going in above keep it in place);
/// scrolling back to the end resumes it. Content runs under the bars and the composer
/// (what lies outside the safe area becomes the list's insets).
struct ConversationList: View {
    let rows: [ConversationRow]
    @Binding var following: Bool
    /// The reader scrolled up near the top: time to bring in earlier messages.
    var nearTop: (() -> Void)?
    /// The safe area (under the bars, above the composer and the keyboard) and the whole screen.
    @State private var safeFrame = CGRect.zero
    @State private var fullFrame = CGRect.zero

    var body: some View {
        ZStack {
            GeometryReader { _ in
                Color.clear.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { fullFrame = $0 }
            }
            .ignoresSafeArea()
            // The list itself stays inside the safe area (so its rows never see one) and
            // reaches out past it.
            ConversationCollection(rows: rows, following: $following, nearTop: nearTop,
                                   outsets: UIEdgeInsets(top: max(0, safeFrame.minY - fullFrame.minY), left: 0,
                                                         bottom: max(0, fullFrame.maxY - safeFrame.maxY), right: 0))
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { safeFrame = $0 }
        }
        .overlay(alignment: .bottom) {
            JumpToLatest(visible: !following && !rows.isEmpty) { following = true }
        }
    }
}

private struct ConversationCollection: UIViewRepresentable {
    let rows: [ConversationRow]
    @Binding var following: Bool
    let nearTop: (() -> Void)?
    /// How far past its frame the list reaches: under the bars, the composer and the keyboard.
    let outsets: UIEdgeInsets

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ConversationContainer {
        let view = ConversationContainer(list: context.coordinator.makeView())
        context.coordinator.update(self, context: context)
        return view
    }

    func updateUIView(_ view: ConversationContainer, context: Context) {
        context.coordinator.update(self, context: context)
    }

    @MainActor final class Coordinator: NSObject, UICollectionViewDelegate {
        private var view: ConversationCollectionView!
        private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
        private var contents: [String: AnyView] = [:]
        private var environment = EnvironmentValues()
        private var parent: ConversationCollection?
        /// What the list is telling `following` (it reaches the binding after the update).
        private var pending: Bool?
        private var lastId: String?
        private var lastOffset: CGFloat = 0
        private var reduceMotion = false

        func makeView() -> ConversationCollectionView {
            let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(80))
            let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [NSCollectionLayoutItem(layoutSize: size)])
            let section = NSCollectionLayoutSection(group: group)
            section.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0)
            let view = ConversationCollectionView(frame: .zero, collectionViewLayout: ConversationLayout(section: section))
            view.backgroundColor = .clear
            view.contentInsetAdjustmentBehavior = .never
            view.showsVerticalScrollIndicator = false
            view.showsHorizontalScrollIndicator = false
            view.alwaysBounceVertical = true
            view.keyboardDismissMode = .interactive
            view.allowsSelection = false
            view.delegate = self
            if #available(iOS 26, *) { view.topEdgeEffect.style = .soft }
            // Tapping the conversation puts the keyboard away; the rows still get the tap.
            let tap = UITapGestureRecognizer(target: view, action: #selector(UIView.endEditing(_:)))
            tap.cancelsTouchesInView = false
            view.addGestureRecognizer(tap)

            let cell = UICollectionView.CellRegistration<UICollectionViewCell, String> { [weak self] cell, _, id in
                guard let self else { return }
                cell.backgroundConfiguration = .clear()
                cell.contentConfiguration = UIHostingConfiguration {
                    ConversationCell(content: contents[id] ?? AnyView(EmptyView()))
                        .environment(\.self, environment)
                        // A reused cell starts fresh (no state carried over from another row).
                        .id(id)
                }
                .margins(.all, 0)
            }
            dataSource = UICollectionViewDiffableDataSource(collectionView: view) { view, indexPath, id in
                view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: id)
            }
            self.view = view
            return view
        }

        func update(_ parent: ConversationCollection, context: Context) {
            self.parent = parent
            environment = context.environment
            reduceMotion = context.environment.accessibilityReduceMotion
            var seen = Set<String>()
            // A repeated id would crash the data source; the first one wins.
            let rows = parent.rows.filter { seen.insert($0.id).inserted }
            contents = Dictionary(rows.map { ($0.id, $0.content) }, uniquingKeysWith: { a, _ in a })

            // Reserve the offset before any snapshot or inset update can lay out the list.
            // Otherwise enabling following pins it to the end before the animation starts.
            let sent = lastId != nil && (rows.last.map { $0.id != lastId && $0.isUserMessage } ?? false)
            let jump = pending == nil && parent.following && !view.following
            if jump || sent { view.prepareToScrollToEnd(animated: !reduceMotion) }
            if let pending {
                if parent.following == pending { self.pending = nil }
            } else if parent.following != view.following {
                view.following = parent.following
            }
            if sent { setFollowing(true) }

            if let container = view.superview as? ConversationContainer, container.outsets != parent.outsets {
                animate(context.transaction.animation) {
                    container.outsets = parent.outsets
                    container.layoutIfNeeded()
                }
            }

            let ids = rows.map(\.id)
            let old = dataSource.snapshot().itemIdentifiers
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ids)
            // Rows that stay re-render with their new content (SwiftUI skips what didn't change).
            let kept = Set(old)
            snapshot.reconfigureItems(ids.filter(kept.contains))
            let first = lastId == nil
            lastId = rows.last?.id

            if old == ids || first || view.scrollingToEnd || jump || sent {
                dataSource.apply(snapshot, animatingDifferences: false)
            } else if view.following, !reduceMotion {
                // New rows pop in as the list moves up to them, in one motion (Grok Bot's
                // 0.24 s ease-out).
                UIViewPropertyAnimator(duration: 0.24, controlPoint1: CGPoint(x: 0.23, y: 1),
                                       controlPoint2: CGPoint(x: 0.32, y: 1)) {
                    self.dataSource.apply(snapshot, animatingDifferences: true)
                    self.view.layoutIfNeeded()
                    self.view.pinToEnd()
                }
                .startAnimation()
            } else {
                applyKeepingPlace(snapshot)
            }
            if jump || sent { view.scrollToEnd(animated: !reduceMotion) }
        }

        /// Rows going in or out above: the first row on screen stays where it is.
        private func applyKeepingPlace(_ snapshot: NSDiffableDataSourceSnapshot<Int, String>) {
            let anchor = view.indexPathsForVisibleItems.min().flatMap { path in
                dataSource.itemIdentifier(for: path).map { ($0, (view.layoutAttributesForItem(at: path)?.frame.minY ?? 0) - view.contentOffset.y) }
            }
            dataSource.apply(snapshot, animatingDifferences: false)
            guard !view.following, let (id, offset) = anchor, let path = dataSource.indexPath(for: id) else { return }
            view.layoutIfNeeded()
            if let frame = view.layoutAttributesForItem(at: path)?.frame {
                view.contentOffset.y = frame.minY - offset
            }
        }

        private func animate(_ animation: Animation?, _ changes: @escaping () -> Void) {
            if #available(iOS 18, *), animation != nil, !reduceMotion {
                UIView.animate(animation ?? .default, changes: changes)
            } else {
                changes()
            }
        }

        private func setFollowing(_ follow: Bool) {
            guard view.following != follow else { return }
            view.following = follow
            pending = follow
            // Not during SwiftUI's update of this view.
            DispatchQueue.main.async { [weak self] in self?.parent?.following = follow }
        }

        // MARK: scrolling

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            view.cancelScrollingToEnd()
            lastOffset = scrollView.contentOffset.y
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            let y = scrollView.contentOffset.y
            defer { lastOffset = y }
            // Only the reader's own scrolling changes following; layout never does.
            guard scrollView.isTracking || scrollView.isDecelerating else { return }
            setFollowing(view.followingAfterScroll(from: lastOffset))
            if !view.following, y + scrollView.adjustedContentInset.top < scrollView.bounds.height / 2 {
                parent?.nearTop?()
            }
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { settle() }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            settle()
        }

        func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
            view.cancelScrollingToEnd()
            setFollowing(false)
            return true
        }

        func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
            parent?.nearTop?()
        }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
            if view.following { view.pinToEnd() }
        }

        /// The reader stopped scrolling: resting at the end follows again; anywhere else stays put.
        private func settle() {
            setFollowing(view.endOffset - view.contentOffset.y < ConversationCollectionView.nearEnd)
            if view.following { view.pinToEnd() }
        }
    }
}

/// A row going in rises into place from slightly below and smaller (Grok Bot's message pop).
private final class ConversationLayout: UICollectionViewCompositionalLayout {
    private var inserted = Set<IndexPath>()

    override func prepare(forCollectionViewUpdates updateItems: [UICollectionViewUpdateItem]) {
        super.prepare(forCollectionViewUpdates: updateItems)
        inserted = Set(updateItems.filter { $0.updateAction == .insert }.compactMap(\.indexPathAfterUpdate))
    }

    override func finalizeCollectionViewUpdates() {
        super.finalizeCollectionViewUpdates()
        inserted = []
    }

    override func initialLayoutAttributesForAppearingItem(at itemIndexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let attributes = super.initialLayoutAttributesForAppearingItem(at: itemIndexPath)
        guard inserted.contains(itemIndexPath), let attributes = attributes?.copy() as? UICollectionViewLayoutAttributes
        else { return attributes }
        attributes.alpha = 0
        attributes.transform = CGAffineTransform(translationX: 0, y: 12).scaledBy(x: 0.94, y: 0.94)
        return attributes
    }
}

/// Holds the list inside the safe area and lets it reach past it by `outsets`, which become
/// its content insets: rows scroll under the bars and the composer but never get a safe area
/// of their own (a row taking one as padding near an edge would resize itself as it moves).
private final class ConversationContainer: UIView {
    let list: ConversationCollectionView
    var outsets = UIEdgeInsets.zero {
        didSet { if outsets != oldValue { setNeedsLayout() } }
    }

    init(list: ConversationCollectionView) {
        self.list = list
        super.init(frame: .zero)
        addSubview(list)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        list.frame = bounds.inset(by: UIEdgeInsets(top: -outsets.top, left: 0, bottom: -outsets.bottom, right: 0))
        if list.contentInset != outsets {
            list.contentInset = outsets
            list.verticalScrollIndicatorInsets = outsets
            if list.following { list.pinToEnd() }
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        list.frame.contains(point)
    }
}

private struct ConversationCell: View {
    let content: AnyView

    var body: some View {
        content
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Scrolled away from the newest messages: a round button back down to them.
struct JumpToLatest: View {
    let visible: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if visible {
                Button("Jump to latest", systemImage: "arrow.down", action: action)
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle())
                    .frosted(in: Circle())
                    .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
                    .help("Jump to latest")
                    .padding(.bottom, 10)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .animation(Motion.reduced(Motion.layout, reduceMotion), value: visible)
    }
}
