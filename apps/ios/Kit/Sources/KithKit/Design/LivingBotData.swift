import CoreGraphics
import Foundation

/// The living bots' data: eyes.json (branding's rig for every body) and tracks.json (designer's
/// keyframes), both bundled as they were made. Units in eyes.json are fractions of the square
/// body canvas, origin top-left, y down.
struct BotEye: Decodable, Sendable, Equatable {
    var x: Double, y: Double, w: Double, h: Double, tilt: Double
}

struct BotLook: Decodable, Sendable, Equatable {
    var left: Double, right: Double, up: Double, down: Double
}

struct BotPoint: Decodable, Sendable, Equatable {
    var x: Double, y: Double
}

/// Where the body sits inside a group's tile: scale about the tile centre, then shift (fractions of the tile).
struct BotPlacement: Decodable, Sendable, Equatable {
    var scale: Double, dx: Double, dy: Double
    static let identity = BotPlacement(scale: 1, dx: 0, dy: 0)
}

struct BotRig: Decodable, Sendable {
    var kind: String
    var eyes: [BotEye]
    var look: BotLook
    var anchor: BotPoint
    var tint: Bool
    var detail: Bool
    var colors: PalettePair?
    var group: BotPlacement?
}

struct PalettePair: Decodable, Sendable, Equatable {
    var id: String?
    var a: String
    var b: String
}

struct BotTrack: Sendable {
    struct Key: Sendable {
        var t: Double
        var gx = 0.0, gy = 0.0
        var sx = 1.0, sy = 1.0, ty = 0.0
        /// Blink and droop scale; nil is "closed" (resolved per size).
        var s: Double?
        var ease: String
    }
    var name: String
    var duration: Double
    var channel: String
    var keys: [Key]
}

enum LivingBotData {
    private struct Eyes: Decodable { var bots: [String: BotRig]; var palette: [PalettePair] }

    private struct Tracks: Decodable {
        struct Raw: Decodable {
            var name: String, duration: Double, channel: String
            var keyframes: [Frame]
        }
        struct Frame: Decodable {
            var t: Double
            var gx: Double?, gy: Double?, sx: Double?, sy: Double?, ty: Double?
            var s: Scale?
            var ease: String
        }
        enum Scale: Decodable {
            case value(Double), closed
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let v = try? c.decode(Double.self) { self = .value(v) } else { self = .closed }
            }
        }
        var ease: [String: [Double]]
        var tracks: [Raw]
    }

    private static func data(_ name: String) -> Data? {
        Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "LivingBots").flatMap { try? Data(contentsOf: $0) }
    }

    static let rigs: [String: BotRig] = {
        data("eyes").flatMap { try? JSONDecoder().decode(Eyes.self, from: $0).bots } ?? [:]
    }()

    static let palette: [PalettePair] = {
        data("eyes").flatMap { try? JSONDecoder().decode(Eyes.self, from: $0).palette } ?? []
    }()

    private static let decodedTracks: Tracks? = data("tracks").flatMap { try? JSONDecoder().decode(Tracks.self, from: $0) }

    static let tracks: [String: BotTrack] = {
        var out: [String: BotTrack] = [:]
        for raw in decodedTracks?.tracks ?? [] {
            let keys = raw.keyframes.map { f -> BotTrack.Key in
                var k = BotTrack.Key(t: f.t, ease: f.ease)
                k.gx = f.gx ?? 0; k.gy = f.gy ?? 0
                k.sx = f.sx ?? 1; k.sy = f.sy ?? 1; k.ty = f.ty ?? 0
                if case .value(let v) = f.s { k.s = v }
                return k
            }
            out[raw.name] = BotTrack(name: raw.name, duration: raw.duration, channel: raw.channel, keys: keys)
        }
        return out
    }()

    /// Control points of a named easing (`saccade`, `sine`, `out`, `in`, `blinkClose`, `blinkOpen`, `linear`).
    static func ease(_ name: String) -> [Double] {
        decodedTracks?.ease[name] ?? [0, 0, 1, 1]
    }

    /// The rig of an asset name (`crew-lab`, `spare-chart`, `kith-cube`); unknown ones are the builder's.
    static func rig(forAsset asset: String) -> BotRig? {
        rigs[rigKey(asset)] ?? rigs["builder"]
    }

    static func rigKey(_ asset: String) -> String {
        if asset == "kith-cube" { return "kith" }
        for prefix in ["crew-", "spare-"] where asset.hasPrefix(prefix) { return String(asset.dropFirst(prefix.count)) }
        return asset
    }
}
