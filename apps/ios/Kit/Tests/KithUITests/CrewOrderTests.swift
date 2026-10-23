import Testing
@testable import KithUI

private func item(_ id: String, computer: Int = 0, pinned: Bool = false, position: Int = 0, lastAt: Int64 = 0,
                  needsYou: Bool = false, working: Bool = false) -> CrewOrderItem {
    CrewOrderItem(id: id, computer: computer, pinned: pinned, position: position, lastAt: lastAt, needsYou: needsYou, working: working)
}

@Test func automaticOrdersNeedsYouThenWorkingThenRecent() {
    let items = [
        item("old", lastAt: 1), item("new", lastAt: 9), item("busy", lastAt: 2, working: true),
        item("asks", lastAt: 0, needsYou: true),
    ]
    #expect(CrewOrder.sorted(items, mode: .automatic) == ["asks", "busy", "new", "old"])
}

@Test func pinnedRoomsStayOnTopInDragOrderInBothModes() {
    let items = [
        item("a", lastAt: 5, needsYou: true), item("p2", pinned: true, position: 1), item("p1", pinned: true, position: 0, lastAt: 1),
        item("b", lastAt: 4),
    ]
    #expect(CrewOrder.sorted(items, mode: .automatic) == ["p1", "p2", "a", "b"])
    #expect(CrewOrder.sorted(items, mode: .manual).prefix(2) == ["p1", "p2"])
}

@Test func storedManualOrderBreaksTiesInAutomatic() {
    let items = [item("b", position: 1, lastAt: 3), item("a", position: 0, lastAt: 3), item("c", position: 2, lastAt: 3)]
    #expect(CrewOrder.sorted(items, mode: .automatic) == ["a", "b", "c"])
}

@Test func manualUsesDragOrderThenRecentForEverything() {
    let items = [item("x", position: 2, needsYou: true), item("y", position: 0, lastAt: 1), item("z", position: 1, working: true)]
    #expect(CrewOrder.sorted(items, mode: .manual) == ["y", "z", "x"])
    // Switching to automatic never rewrites positions: the same items still sort manually afterwards.
    #expect(CrewOrder.sorted(items, mode: .automatic) == ["x", "z", "y"])
    #expect(CrewOrder.sorted(items, mode: .manual) == ["y", "z", "x"])
}

@Test func dragIsOfferedOnPinnedAndOnEveryRoomInManual() {
    #expect(CrewOrder.canReorder(pinned: true, mode: .automatic))
    #expect(!CrewOrder.canReorder(pinned: false, mode: .automatic))
    #expect(CrewOrder.canReorder(pinned: false, mode: .manual))
}

@Test func orderHoldKeepsTheListStillWhileFrozen() {
    var hold = CrewOrderHold()
    #expect(hold.update(computed: ["a", "b", "c"], frozen: false) == ["a", "b", "c"])
    // Something changed under the finger: nothing moves, a gone room drops out, a new one goes last.
    #expect(hold.update(computed: ["c", "d", "a"], frozen: true) == ["a", "c", "d"])
    // Let go: the computed order is adopted.
    #expect(hold.update(computed: ["c", "d", "a"], frozen: false) == ["c", "d", "a"])
}

@Test func orderModeFallsBackToAutomatic() {
    #expect(CrewOrderMode(stored: "") == .automatic)
    #expect(CrewOrderMode(stored: "manual") == .manual)
}

@Test func dockSearchRanksNameBeforePersonBeforeStatus() {
    let entries = [
        CrewSearchEntry(id: "status", name: "house", status: "Coder will review milk list"),
        CrewSearchEntry(id: "person", name: "launch", people: ["Mia coder"]),
        CrewSearchEntry(id: "name", name: "coder"),
        CrewSearchEntry(id: "none", name: "finance", status: "October summary"),
    ]
    #expect(CrewSearch.rank(entries, query: "cod") == ["name", "person", "status"])
    #expect(CrewSearch.rank(entries, query: "zzz").isEmpty)
}

@Test func dockSearchNeedsEveryWordAndKeepsListOrderOnTies() {
    let entries = [
        CrewSearchEntry(id: "1", name: "design", status: "Pick the tab icon set"),
        CrewSearchEntry(id: "2", name: "design lab", status: "Pick the colours"),
        CrewSearchEntry(id: "3", name: "design notes", status: "tab icon set"),
    ]
    #expect(CrewSearch.rank(entries, query: "design tab") == ["3", "1"])
    #expect(CrewSearch.rank(entries, query: "design") == ["1", "2", "3"])
    #expect(CrewSearch.rank(entries, query: "  ") == ["1", "2", "3"])
}

@Test func manualGroupsRoomsByComputerThenOwnOrder() {
    let items = [
        item("b0", computer: 1, position: 0), item("a1", computer: 0, position: 1), item("b1", computer: 1, position: 1),
        item("a0", computer: 0, position: 0), item("pb", computer: 1, pinned: true), item("pa", computer: 0, pinned: true),
    ]
    #expect(CrewOrder.sorted(items, mode: .manual) == ["pa", "pb", "a0", "a1", "b0", "b1"])
}
