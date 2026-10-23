/**
 * A ring for an incoming call: two short soft beeps every two seconds, made with Web Audio so nothing is bundled.
 * Returns the function that stops it. Silent when the browser has no audio or refuses to start it.
 */
export function ringTone(): () => void {
  let context: AudioContext | null = null
  try {
    context = new AudioContext()
    void context.resume()
  } catch {
    return () => {}
  }
  const ctx = context
  const beep = (at: number) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.12, at + 0.02)
    gain.gain.linearRampToValueAtTime(0, at + 0.22)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.25)
  }
  const ring = () => {
    beep(ctx.currentTime)
    beep(ctx.currentTime + 0.35)
  }
  ring()
  const timer = setInterval(ring, 2000)
  return () => {
    clearInterval(timer)
    void ctx.close().catch(() => {})
  }
}
