// Draws the DMG window background: `swift background.swift <out.tiff>`.
// 660×400 points (1x + 2x in one TIFF); icons sit at (170, 200) and (490, 200), see release-macos.yml.
import AppKit

let size = NSSize(width: 660, height: 400)

func render(scale: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    NSGradient(starting: NSColor(white: 1, alpha: 1), ending: NSColor(white: 0.94, alpha: 1))!
        .draw(in: NSRect(origin: .zero, size: size), angle: -90)

    // Arrow between the two icons (Finder's y grows down; AppKit's grows up).
    let y = size.height - 200
    let gray = NSColor(white: 0.62, alpha: 1)
    gray.setStroke()
    let line = NSBezierPath()
    line.move(to: NSPoint(x: 262, y: y))
    line.line(to: NSPoint(x: 392, y: y))
    line.lineWidth = 3
    line.lineCapStyle = .round
    line.setLineDash([2, 9], count: 2, phase: 0)
    line.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: 386, y: y + 11))
    head.line(to: NSPoint(x: 400, y: y))
    head.line(to: NSPoint(x: 386, y: y - 11))
    head.lineWidth = 3
    head.lineCapStyle = .round
    head.lineJoinStyle = .round
    head.stroke()

    let title = NSAttributedString(string: "Drag Codync to Applications", attributes: [
        .font: NSFont.systemFont(ofSize: 17, weight: .semibold),
        .foregroundColor: NSColor(white: 0.15, alpha: 1),
    ])
    title.draw(at: NSPoint(x: (size.width - title.size().width) / 2, y: size.height - 72))
    let hint = NSAttributedString(string: "Then open Codync. It sets up everything else.", attributes: [
        .font: NSFont.systemFont(ofSize: 12),
        .foregroundColor: NSColor(white: 0.45, alpha: 1),
    ])
    hint.draw(at: NSPoint(x: (size.width - hint.size().width) / 2, y: 48))

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let image = NSImage(size: size)
image.addRepresentation(render(scale: 1))
image.addRepresentation(render(scale: 2))
try! image.tiffRepresentation(using: .lzw, factor: 0)!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
