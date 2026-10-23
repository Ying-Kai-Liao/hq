import SwiftUI
import UIKit

/// One bot's Core Animation rig (MOTION.md section 1): body > gaze > eye (blink) > droop > oval.
/// Everything moves as keyframe animations the render server runs; the view does no per-frame
/// work. Animations are dropped while the bot is off screen, the app is in the background or
/// the avatar is out of the full-tier cap, and come back with the mount phase.
@MainActor
final class LivingBotUIView: UIView {
    struct Spec: Equatable {
        var asset: String
        var paletteId: String?
        var botId: String
        var size: CGFloat
        var mood: CharacterAvatar.Mood
        var placement: BotPlacement = .identity
    }

    private(set) var spec: Spec?
    private var geometry: BotGeometry?
    private var seed = LivingSeed(id: "")
    private var done = DoneGate()
    private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    private var appActive = true
    fileprivate var fullAllowed = true
    private var animating = false
    private var tierWas: AvatarTier?

    private let bodyLayer = CALayer()
    private let gazeLayer = CALayer()
    private var blinkLayers: [CALayer] = []
    private var droopLayers: [CALayer] = []
    private var closed = 0.1

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        layer.addSublayer(bodyLayer)
        bodyLayer.addSublayer(gazeLayer)
        bodyLayer.magnificationFilter = .linear
        bodyLayer.minificationFilter = .trilinear
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(powerChanged), name: .NSProcessInfoPowerStateDidChange, object: nil)
        nc.addObserver(self, selector: #selector(activeChanged), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(activeChanged), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(activeChanged), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { CGSize(width: spec?.size ?? 0, height: spec?.size ?? 0) }

    // MARK: State in

    func configure(_ new: Spec) {
        let old = spec
        spec = new
        if old?.asset != new.asset || old?.paletteId != new.paletteId || old?.size != new.size || old?.placement != new.placement {
            seed = LivingSeed(id: new.botId)
            rebuild()
        }
        if old == nil {
            _ = done.moodChanged(from: nil, to: new.mood)
            tierWas = nil
            refresh(moodChanged: false, previous: nil)
        } else if old?.mood != new.mood {
            refresh(moodChanged: true, previous: old?.mood)
        } else if old != new {
            refresh(moodChanged: false, previous: nil)
        }
    }

    @objc private func powerChanged() {
        lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        refresh(moodChanged: false, previous: nil)
    }

    @objc private func activeChanged(_ note: Notification) {
        appActive = note.name == UIApplication.didBecomeActiveNotification
        refresh(moodChanged: false, previous: nil)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil, (spec?.size ?? 0) >= AvatarTier.fullFrom { FullAvatarCap.shared.add(self) }
        else { FullAvatarCap.shared.remove(self) }
        refresh(moodChanged: false, previous: nil)
    }

    fileprivate func capChanged(_ allowed: Bool) {
        guard allowed != fullAllowed else { return }
        fullAllowed = allowed
        refresh(moodChanged: false, previous: nil)
    }

    // MARK: Layers

    private func rebuild() {
        guard let spec, let rig = LivingBotData.rig(forAsset: spec.asset) else { return }
        let g = BotGeometry(rig: rig, size: spec.size, placement: spec.placement)
        geometry = g
        let scale = window?.screen.scale ?? traitCollection.displayScale
        let box = g.body
        bodyLayer.contents = LivingBotTint.image(asset: spec.asset, paletteId: spec.paletteId)
        bodyLayer.contentsScale = scale
        bodyLayer.bounds = CGRect(origin: .zero, size: box.size)
        bodyLayer.anchorPoint = CGPoint(x: rig.anchor.x, y: rig.anchor.y)
        bodyLayer.position = CGPoint(x: box.minX + rig.anchor.x * box.width, y: box.minY + rig.anchor.y * box.height)
        gazeLayer.frame = bodyLayer.bounds
        gazeLayer.sublayers?.forEach { $0.removeFromSuperlayer() }
        blinkLayers = []; droopLayers = []
        let s = box.width
        for eye in rig.eyes {
            let blink = CALayer(), droop = CALayer(), oval = CAShapeLayer()
            let rect = CGRect(x: 0, y: 0, width: eye.w * s, height: eye.h * s)
            for l in [blink, droop, oval] { l.bounds = rect }
            blink.position = CGPoint(x: eye.x * s, y: eye.y * s)
            droop.position = CGPoint(x: rect.midX, y: rect.midY)
            oval.position = droop.position
            oval.path = CGPath(ellipseIn: rect, transform: nil)
            oval.fillColor = UIColor.black.cgColor
            oval.setAffineTransform(CGAffineTransform(rotationAngle: eye.tilt * .pi / 180))
            oval.shouldRasterize = false
            blink.addSublayer(droop); droop.addSublayer(oval)
            gazeLayer.addSublayer(blink)
            blinkLayers.append(blink); droopLayers.append(droop)
        }
        closed = BotPose.closed(eyeHeight: rig.eyes.first?.h ?? 0.12, size: s)
        tierWas = nil
        invalidateIntrinsicContentSize()
    }

    // MARK: Motion

    private var tier: AvatarTier {
        guard window != nil, appActive, let spec else { return .still }
        return .tier(size: spec.size, reduceMotion: false, lowPower: lowPower, capped: !fullAllowed)
    }

    private func clearMotion(includingBlink: Bool) {
        for l in [bodyLayer, gazeLayer] { l.removeAllAnimations() }
        for l in droopLayers { l.removeAllAnimations() }
        if includingBlink { for l in blinkLayers { l.removeAllAnimations() } }
    }

    /// Re-evaluates what runs: after a state change (with the handoff), or after a change in
    /// tier, visibility or size (re-mounted with the phase).
    private func refresh(moodChanged: Bool, previous: CharacterAvatar.Mood?) {
        guard let spec, geometry != nil else { return }
        let tier = tier
        let playDone = moodChanged && done.moodChanged(from: previous, to: spec.mood)
        if tier == .still {
            clearMotion(includingBlink: true)
            setStatic(spec.mood)
            animating = false; tierWas = tier
            return
        }
        if moodChanged, animating, tierWas == tier {
            handoff(from: previous, playDone: playDone)
        } else {
            clearMotion(includingBlink: true)
            resetModel()
            startBlink()
            startState(delay: 0, mount: true, tier: tier)
        }
        animating = true; tierWas = tier
    }

    private func resetModel() {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        bodyLayer.transform = CATransform3DIdentity
        gazeLayer.transform = CATransform3DIdentity
        droopLayers.forEach { $0.transform = CATransform3DIdentity }
        CATransaction.commit()
    }

    private func setStatic(_ mood: CharacterAvatar.Mood) {
        guard let g = geometry else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let pose = BotPose.gaze(mood)
        let off = g.gazeOffset(pose.x, pose.y)
        gazeLayer.transform = CATransform3DMakeTranslation(off.width, off.height, 0)
        let err = mood == .error
        bodyLayer.transform = err ? CATransform3DMakeScale(BotPose.slump.sx, BotPose.slump.sy, 1) : CATransform3DIdentity
        droopLayers.forEach { $0.transform = CATransform3DMakeScale(1, err ? BotPose.droop : 1, 1) }
        CATransaction.commit()
    }

    private func now() -> Double { CACurrentMediaTime() }

    private func startBlink() {
        let t = LivingBotData.tracks["blink-\(seed.blinkTrack)"]
        guard let t else { return }
        for l in blinkLayers {
            l.add(keyframes(t, keyPath: "transform.scale.y", on: l, values: t.keys.map { $0.s ?? closed }, loop: true,
                            phaseMs: LivingSeed.phase(f: seed.fBlink, length: t.duration, nowMs: Date().timeIntervalSince1970 * 1000)), forKey: "blink")
        }
    }

    /// Animations of the current mood's entry and loops, starting `delay` s from now. A mount
    /// starts mid-loop at the bot's phase and skips entries; a state change starts at phase 0.
    private func startState(delay: Double, mount: Bool, tier: AvatarTier) {
        guard let spec, let g = geometry else { return }
        let nowMs = Date().timeIntervalSince1970 * 1000
        let tracks = LivingBotData.tracks
        func loop(_ name: String, f: Double) {
            guard let t = tracks[name] else { return }
            let phase = mount ? LivingSeed.phase(f: f, length: t.duration, nowMs: nowMs) : 0
            addTrack(t, loop: true, delay: delay, phaseMs: phase, geometry: g)
        }
        func once(_ name: String, hold: Bool = false, delay d: Double) {
            guard let t = tracks[name] else { return }
            addTrack(t, loop: false, delay: d, phaseMs: 0, geometry: g, hold: hold)
        }
        func pose(_ mood: CharacterAvatar.Mood) {
            let p = BotPose.gaze(mood)
            guard p.x != 0 || p.y != 0 else { return }
            let off = g.gazeOffset(p.x, p.y)
            for (path, v) in [("transform.translation.x", off.width), ("transform.translation.y", off.height)] {
                let a = CABasicAnimation(keyPath: path)
                a.fromValue = 0; a.toValue = v; a.duration = 0.11
                a.timingFunction = timing("saccade")
                a.beginTime = gazeLayer.convertTime(now(), from: nil) + delay
                a.fillMode = .forwards; a.isRemovedOnCompletion = false
                gazeLayer.add(a, forKey: "m.pose" + path)
            }
        }
        switch spec.mood {
        case .idle:
            if tier == .full { loop("body-idle", f: seed.fBody); loop("look-idle-\(seed.lookTrack)", f: seed.fLook) }
        case .working:
            if tier == .full { loop("body-working", f: seed.fBody); loop("look-working", f: seed.fLook) } else { pose(.working) }
        case .needsInput:
            if !mount, NeedsEntryThrottle.shouldPlay(id: spec.botId), let enter = tracks["body-needs-enter"] {
                addTrack(enter, loop: false, delay: delay, phaseMs: 0, geometry: g)
                if let t = tracks["body-needs-loop"] {
                    addTrack(t, loop: true, delay: delay + enter.duration / 1000, phaseMs: 0, geometry: g)
                }
            } else { loop("body-needs-loop", f: seed.fBody) }
        case .error:
            once("body-error-enter", hold: true, delay: delay)
            for l in droopLayers {
                let a = CABasicAnimation(keyPath: "transform.scale.y")
                a.fromValue = 1; a.toValue = BotPose.droop; a.duration = 0.42
                a.timingFunction = timing("sine")
                a.beginTime = l.convertTime(now(), from: nil) + delay
                a.fillMode = .forwards; a.isRemovedOnCompletion = false
                l.add(a, forKey: "m.droop")
            }
            if tier == .full { loop("look-error", f: seed.fLook) } else { pose(.error) }
        }
    }

    /// Every state change: cancel what runs, ease the presented pose to identity in 160 ms,
    /// then start the new state's entry or loop. The blink loop is left alone.
    private func handoff(from previous: CharacterAvatar.Mood?, playDone: Bool) {
        guard let spec, let g = geometry else { return }
        func presented(_ l: CALayer, _ path: String, _ identity: Double) -> Double {
            (l.presentation()?.value(forKeyPath: path) as? Double) ?? identity
        }
        let body = (presented(bodyLayer, "transform.scale.x", 1), presented(bodyLayer, "transform.scale.y", 1),
                    presented(bodyLayer, "transform.translation.y", 0))
        let gaze = (presented(gazeLayer, "transform.translation.x", 0), presented(gazeLayer, "transform.translation.y", 0))
        let droops = droopLayers.map { presented($0, "transform.scale.y", 1) }
        clearMotion(includingBlink: false)
        resetModel()
        func ease(_ l: CALayer, _ path: String, from: Double, to: Double, curve: String, d: Double) {
            guard abs(from - to) > 0.0005 else { return }
            let a = CABasicAnimation(keyPath: path)
            a.fromValue = from; a.toValue = to; a.duration = d
            a.timingFunction = timing(curve)
            l.add(a, forKey: "m.handoff" + path)
        }
        ease(bodyLayer, "transform.scale.x", from: body.0, to: 1, curve: "sine", d: 0.16)
        ease(bodyLayer, "transform.scale.y", from: body.1, to: 1, curve: "sine", d: 0.16)
        ease(bodyLayer, "transform.translation.y", from: body.2, to: 0, curve: "sine", d: 0.16)
        ease(gazeLayer, "transform.translation.x", from: gaze.0, to: 0, curve: "saccade", d: 0.11)
        ease(gazeLayer, "transform.translation.y", from: gaze.1, to: 0, curve: "saccade", d: 0.11)
        for (l, v) in zip(droopLayers, droops) { ease(l, "transform.scale.y", from: v, to: 1, curve: "sine", d: 0.16) }
        let tier = tier
        if playDone, spec.mood == .idle {
            if let t = LivingBotData.tracks["body-done"] { addTrack(t, loop: false, delay: 0.16, phaseMs: 0, geometry: g) }
            if let t = LivingBotData.tracks["eye-done"] {
                for l in droopLayers {
                    l.add(keyframes(t, keyPath: "transform.scale.y", on: l, values: t.keys.map { $0.s ?? closed }, loop: false,
                                    phaseMs: 0, delay: 0.16), forKey: "m.eyedone")
                }
            }
            startState(delay: 0.16 + 0.9, mount: false, tier: tier)
        } else {
            startState(delay: 0.16, mount: false, tier: tier)
        }
    }

    // MARK: Tracks to animations

    private func timing(_ name: String) -> CAMediaTimingFunction {
        let c = LivingBotData.ease(name).map(Float.init)
        return c.count == 4 ? CAMediaTimingFunction(controlPoints: c[0], c[1], c[2], c[3]) : CAMediaTimingFunction(name: .linear)
    }

    private func keyframes(_ t: BotTrack, keyPath: String, on layer: CALayer, values: [Double], loop: Bool,
                           phaseMs: Double, delay: Double = 0, hold: Bool = false) -> CAKeyframeAnimation {
        let a = CAKeyframeAnimation(keyPath: keyPath)
        a.values = values
        a.keyTimes = t.keys.map { NSNumber(value: $0.t / t.duration) }
        a.timingFunctions = t.keys.dropFirst().map { timing($0.ease) }
        a.calculationMode = .linear
        a.duration = t.duration / 1000
        a.beginTime = layer.convertTime(now(), from: nil) + delay
        if loop { a.repeatCount = .infinity; a.timeOffset = phaseMs / 1000 }
        if hold { a.fillMode = .forwards; a.isRemovedOnCompletion = false }
        return a
    }

    private func addTrack(_ t: BotTrack, loop: Bool, delay: Double, phaseMs: Double, geometry g: BotGeometry, hold: Bool = false) {
        func add(_ layer: CALayer, _ path: String, _ values: [Double], key: String) {
            layer.add(keyframes(t, keyPath: path, on: layer, values: values, loop: loop, phaseMs: phaseMs, delay: delay, hold: hold), forKey: key)
        }
        let size = Double(spec?.size ?? 0)
        switch t.channel {
        case "body":
            add(bodyLayer, "transform.scale.x", t.keys.map(\.sx), key: "m.sx")
            add(bodyLayer, "transform.scale.y", t.keys.map(\.sy), key: "m.sy")
            add(bodyLayer, "transform.translation.y", t.keys.map { $0.ty / 100 * size }, key: "m.ty")
        case "gaze":
            add(gazeLayer, "transform.translation.x", t.keys.map { Double(g.gazeOffset($0.gx, 0).width) }, key: "m.gx")
            add(gazeLayer, "transform.translation.y", t.keys.map { Double(g.gazeOffset(0, $0.gy).height) }, key: "m.gy")
        default: break
        }
    }
}

/// No more than six avatars run the full tier in a window; the first six in reading order do.
@MainActor
final class FullAvatarCap {
    static let shared = FullAvatarCap()
    private var views = NSHashTable<LivingBotUIView>.weakObjects()

    func add(_ v: LivingBotUIView) { views.add(v); assign() }
    func remove(_ v: LivingBotUIView) { views.remove(v); v.capChanged(true); assign() }

    private func assign() {
        let ordered = views.allObjects.sorted { a, b in
            let pa = a.convert(CGPoint.zero, to: nil), pb = b.convert(CGPoint.zero, to: nil)
            return abs(pa.y - pb.y) > 1 ? pa.y < pb.y : pa.x < pb.x
        }
        for (i, v) in ordered.enumerated() { v.capChanged(i < AvatarTier.fullCap) }
    }
}

struct LivingBotRepresentable: UIViewRepresentable {
    let spec: LivingBotUIView.Spec

    func makeUIView(context: Context) -> LivingBotUIView {
        let v = LivingBotUIView()
        v.configure(spec)
        return v
    }

    func updateUIView(_ view: LivingBotUIView, context: Context) { view.configure(spec) }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LivingBotUIView, context: Context) -> CGSize? {
        CGSize(width: spec.size, height: spec.size)
    }
}
