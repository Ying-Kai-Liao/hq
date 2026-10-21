// swift-tools-version: 6.0
import PackageDescription

// On-device speech recognition for the desktop app's voice calls (macOS only).
let package = Package(
    name: "codync-speech",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "codync-speech", path: "Sources")]
)
