/// Keep fetched catalog metadata in memory, but create rows only as the user requests them.
struct MarketplacePage<Item: Identifiable> {
    private(set) var items: [Item] = []
    private(set) var visibleCount = 12

    var visible: ArraySlice<Item> { items.prefix(visibleCount) }
    var hasHiddenItems: Bool { items.count > visibleCount }
    var isEmpty: Bool { items.isEmpty }

    mutating func replace(with items: [Item]) {
        self.items = []
        visibleCount = 12
        append(items)
    }

    mutating func append(_ page: [Item]) {
        var known = Set(items.map(\.id))
        items += page.filter { known.insert($0.id).inserted }
    }

    mutating func revealMore() {
        visibleCount = min(items.count, visibleCount + 12)
    }
}
