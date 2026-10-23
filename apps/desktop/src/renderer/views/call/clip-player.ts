import { decodeWav, fadeEdges, PlaybackSchedule } from './audio-chain'

/** While a possible talk-over is being judged, the voice is this loud. */
const DUCKED_GAIN = 0.2

/**
 * Plays the voice's clips through one AudioContext: each is decoded and edge-faded once, then
 * scheduled on the audio clock right behind the one before (AudioBufferSourceNode.start(at)), so
 * the joins have no gap. A gain node ducks the voice; `setSinkId` moves the whole context to the
 * chosen speaker.
 */
export class ClipPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private schedule = new PlaybackSchedule()
  private sinkId = ''
  /** Bumped by every cut: a clip that was being set up across one is dropped. */
  private cuts = 0
  /** The chosen speaker couldn't be used and the default took over. */
  onSinkLost: ((error: unknown) => void) | null = null
  /** Every queued clip has played out. */
  onDrained: (() => void) | null = null

  get idle() {
    return this.schedule.idle
  }

  /** '' goes back to the system default. Resolves once the context follows (or throws if it can't). */
  async setSink(deviceId: string) {
    this.sinkId = deviceId
    if (this.ctx) await this.applySink(this.ctx)
  }

  /** Queues a clip behind the ones already queued. False if it couldn't be read. */
  async add(wav: Uint8Array, started?: () => void): Promise<boolean> {
    const clip = decodeWav(wav)
    if (!clip || clip.samples.length === 0) return false
    fadeEdges(clip.samples, clip.sampleRate)
    const cuts = this.cuts
    const live = await this.context()
    // Cut (or the call ended) while the context was being set up: nothing to play.
    if (!live || cuts !== this.cuts) return true
    const { ctx, gain } = live
    const buffer = ctx.createBuffer(1, clip.samples.length, clip.sampleRate)
    buffer.getChannelData(0).set(clip.samples)
    // The context resamples the clip's rate to the device's.
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    const wasIdle = this.schedule.idle
    const { at, token } = this.schedule.add(ctx.currentTime, buffer.duration)
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
      if (this.schedule.done(token)) this.onDrained?.()
    }
    source.start(at)
    if (wasIdle) {
      started?.()
    }
    return true
  }

  /** A ~10 ms ramp, not a step, so ducking doesn't click. */
  duck(on: boolean) {
    if (this.ctx && this.gain) this.gain.gain.setTargetAtTime(on ? DUCKED_GAIN : 1, this.ctx.currentTime, 0.01)
  }

  /** Drops what's queued and stops at once. */
  stop() {
    this.cuts++
    this.schedule.cut()
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Not started yet is fine.
      }
      source.disconnect()
    }
    this.sources.clear()
    if (this.gain) this.gain.gain.cancelScheduledValues(0)
    if (this.gain) this.gain.gain.value = 1
  }

  close() {
    this.stop()
    void this.ctx?.close()
    this.ctx = null
    this.gain = null
  }

  private async context() {
    if (!this.ctx || !this.gain) {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const gain = ctx.createGain()
      gain.connect(ctx.destination)
      this.ctx = ctx
      this.gain = gain
      if (this.sinkId) {
        try {
          await this.applySink(ctx)
        } catch (e) {
          // A speaker that was unplugged: the default output beats a dead voice.
          this.sinkId = ''
          this.onSinkLost?.(e)
        }
      }
    }
    if (!this.ctx) return null
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    return this.ctx && this.gain ? { ctx: this.ctx, gain: this.gain } : null
  }

  private async applySink(ctx: AudioContext) {
    // setSinkId is Chromium's; '' goes back to the system default.
    const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    await sink.setSinkId?.(this.sinkId)
  }
}
