import Testing
import UIKit
@testable import CodyncUI

@MainActor @Test(arguments: ["tracking", "dragging", "decelerating"])
func bottomPinningPreservesNativeOverscrollDuringInteraction(_ phase: String) {
    let view = InteractingConversationView(frame: CGRect(x: 0, y: 0, width: 320, height: 600),
                                           collectionViewLayout: TallConversationLayout())
    view.layoutIfNeeded()
    view.phase = phase
    let overscroll = view.endOffset + 80
    view.contentOffset.y = overscroll
    view.pinToEnd()
    #expect(view.contentOffset.y == overscroll)
    view.setNeedsLayout()
    view.layoutIfNeeded()
    #expect(view.contentOffset.y == overscroll)
    view.phase = nil
    view.pinToEnd()
    #expect(view.contentOffset.y == view.endOffset)
}

@MainActor @Test func bottomBounceKeepsFollowingUntilTheReaderLeavesTheEnd() {
    let view = ConversationCollectionView(frame: CGRect(x: 0, y: 0, width: 320, height: 600),
                                          collectionViewLayout: TallConversationLayout())
    view.layoutIfNeeded()
    let end = view.endOffset
    var previous = end
    for offset in [end + 80, end + 40, end + 10, end] {
        view.contentOffset.y = offset
        view.following = view.followingAfterScroll(from: previous)
        #expect(view.following)
        previous = offset
    }
    view.contentOffset.y = end - 100
    view.following = view.followingAfterScroll(from: previous)
    #expect(!view.following)
    view.contentOffset.y = end - 80
    #expect(!view.followingAfterScroll(from: end - 100))
    view.contentOffset.y = end
    #expect(view.followingAfterScroll(from: end - 80))
}

@MainActor private final class InteractingConversationView: ConversationCollectionView {
    var phase: String?
    override var isTracking: Bool { phase == "tracking" }
    override var isDragging: Bool { phase == "dragging" }
    override var isDecelerating: Bool { phase == "decelerating" }
}

@MainActor private final class TallConversationLayout: UICollectionViewLayout {
    override var collectionViewContentSize: CGSize { CGSize(width: 320, height: 5_000) }
    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? { [] }
}
