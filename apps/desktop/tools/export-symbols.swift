// Renders the SF Symbols the desktop app uses into alpha masks for the macOS build
// (`npm run icons`, macOS only). SF Symbols may only ship in apps for Apple platforms, so the
// output is generated at build time, never committed, and Linux builds use the Lucide fallbacks.
//
// Reads src/renderer/components/symbols.json (names) and writes
// src/renderer/public/symbols/<name>.<weight>.png plus manifest.json with each symbol's
// size and baseline in points per point of font size.
import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath)
let names = try JSONDecoder().decode([String].self, from: Data(contentsOf: root.appending(path: "src/renderer/components/symbols.json")))
let out = root.appending(path: "src/renderer/public/symbols")
try? FileManager.default.removeItem(at: out)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let weights: [(String, NSFont.Weight)] = [
    ("light", .light), ("regular", .regular), ("medium", .medium), ("semibold", .semibold), ("bold", .bold), ("black", .black),
]
/// Rendered at this point size and scale: crisp up to ~40 pt at 2x.
let pointSize: CGFloat = 40
let scale: CGFloat = 2

struct Metrics: Encodable { var w: Double; var h: Double; var baseline: Double }
var manifest: [String: Metrics] = [:]
var missing: [String] = []

for name in names {
    guard NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil else {
        missing.append(name)
        continue
    }
    for (label, weight) in weights {
        let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight, scale: .medium)
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { continue }
        let size = image.size
        if label == "regular" {
            // The alignment rect's bottom sits on the text baseline.
            manifest[name] = Metrics(w: size.width / pointSize, h: size.height / pointSize,
                                     baseline: image.alignmentRect.minY / pointSize)
        }
        let px = NSSize(width: ceil(size.width * scale), height: ceil(size.height * scale))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(px.width), pixelsHigh: Int(px.height),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let tinted = NSImage(size: size, flipped: false) { rect in
            image.draw(in: rect)
            NSColor.black.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        tinted.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        try rep.representation(using: .png, properties: [:])?.write(to: out.appending(path: "\(name).\(label).png"))
    }
}

try JSONEncoder().encode(manifest).write(to: out.appending(path: "manifest.json"))
print("exported \(manifest.count) symbols to \(out.path)")
if !missing.isEmpty { print("unknown symbols: \(missing.joined(separator: ", "))") }
