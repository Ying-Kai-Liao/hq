// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KithKit",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "KithKit", targets: ["KithKit"]),
        .library(name: "KithUI", targets: ["KithUI"]),
    ],
    dependencies: [
        // libwebrtc for the remote screen viewer (hardware H.264 over WebRTC) and realtime voice calls.
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "153.0.0"),
        // Terminal emulator for agent install and sign-in. 1.19+ adds a build-tool
        // plugin every Xcode build would have to trust.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.18.0"),
    ],
    targets: [
        .target(name: "KithKit", resources: [.copy("Resources/ThirdPartyNotices"), .process("Resources/ProviderIcons.xcassets"), .process("Resources/CrewAvatars.xcassets"), .copy("Resources/LivingBots")]),
        .target(
            name: "KithUI",
            dependencies: [
                "KithKit",
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "KithKitTests", dependencies: ["KithKit"], resources: [.copy("Fixtures")]),
        .testTarget(name: "KithUITests", dependencies: ["KithUI", "KithKit"]),
    ]
)
