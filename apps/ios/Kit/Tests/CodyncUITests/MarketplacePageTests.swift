import Testing
@testable import CodyncUI

private struct CatalogItem: Identifiable { let id: Int }

@Test func catalogStartsSmallAndExpandsOnlyWhenRequested() {
    var page = MarketplacePage<CatalogItem>()
    page.replace(with: (0..<60).map { CatalogItem(id: $0) })
    #expect(page.visible.count == 12)
    #expect(page.hasHiddenItems)
    page.revealMore()
    #expect(page.visible.map(\.id) == Array(0..<24))
    #expect(page.items.count == 60)
}

@Test func catalogEndsAtItsActualCount() {
    var page = MarketplacePage<CatalogItem>()
    page.replace(with: (0..<15).map { CatalogItem(id: $0) })
    page.revealMore()
    #expect(page.visible.count == 15)
    #expect(!page.hasHiddenItems)
}

@Test func laterCatalogPagesStayBoundedAndRemoveDuplicates() {
    var page = MarketplacePage<CatalogItem>()
    page.replace(with: (0..<12).map { CatalogItem(id: $0) })
    page.append((10..<60).map { CatalogItem(id: $0) })
    #expect(page.visible.count == 12)
    page.revealMore()
    #expect(page.visible.map(\.id) == Array(0..<24))
    #expect(page.items.count == 60)
}

@Test func newCatalogSearchResetsTheVisibleBatch() {
    var page = MarketplacePage<CatalogItem>()
    page.replace(with: (0..<60).map { CatalogItem(id: $0) })
    page.revealMore()
    page.replace(with: (100..<130).map { CatalogItem(id: $0) })
    #expect(page.visible.map(\.id) == Array(100..<112))
    page.replace(with: [])
    #expect(page.isEmpty)
    #expect(!page.hasHiddenItems)
}
