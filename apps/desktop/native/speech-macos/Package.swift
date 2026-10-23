// swift-tools-version: 6.0
import PackageDescription

// On-device speech recognition for the desktop app's voice calls (macOS only).
let package = Package(
    name: "kith-speech",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "kith-speech", path: "Sources")]
)
