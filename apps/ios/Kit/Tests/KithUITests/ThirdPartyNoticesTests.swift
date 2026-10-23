import Foundation
import Testing
@testable import KithUI

@Test func noticesFileSplitsIntoGroupsPackagesAndTexts() {
    let n = ThirdPartyNotices(markdown: """
    # Third-party notices

    <!-- Generated -->

    Intro line.

    ## MIT

    - foo 1.0.0 (npm)
      https://example.com/foo
      Copyright (c) A
    - bar 2.0.0 (cargo)

    ~~~~~
    ## not a heading
    Permission is hereby granted
    ~~~~~

    ## ISC

    - baz 3 (npm)
    """)
    #expect(n.intro == "Intro line.")
    #expect(n.groups.map(\.license) == ["MIT", "ISC"])
    #expect(n.groups[0].packages == [
        .init(name: "foo 1.0.0 (npm)", details: ["https://example.com/foo", "Copyright (c) A"]),
        .init(name: "bar 2.0.0 (cargo)"),
    ])
    #expect(n.groups[0].texts == ["## not a heading\nPermission is hereby granted"])
    #expect(n.groups[1].packages.count == 1)
}
