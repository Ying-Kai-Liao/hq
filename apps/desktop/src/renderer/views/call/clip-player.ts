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
    const { ctx, gain } = await this.context()
    if (cuts !== this.cuts) return true
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
      gain.gain.value = 1
      started?.()
    }
    return true
  }

  duck(on: boolean) {
    if (this.gain) this.gain.gain.value = on ? DUCKED_GAIN : 1
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
    this.duck(false)
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
      if (this.sinkId) await this.applySink(ctx)
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    return { ctx: this.ctx, gain: this.gain }
  }

  private async applySink(ctx: AudioContext) {
    // setSinkId is Chromium's; '' goes back to the system default.
    const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    await sink.setSinkId?.(this.sinkId)
  }
}
