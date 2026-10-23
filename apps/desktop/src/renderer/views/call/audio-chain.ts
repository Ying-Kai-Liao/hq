// Pure parts of the call's audio chain (kit `VoiceAudio.swift`): WAV decoding, clip edge fades,
// back-to-back scheduling, and the energy detector that ducks and stops the voice when the user
// talks over it. No Web Audio here, so it runs under node:test with synthetic buffers.

export interface DecodedClip {
  samples: Float32Array
  sampleRate: number
}

/** Edge fade at both ends of a clip: kills the click of a cut waveform without eating speech. */
export const FADE_SECONDS = 0.005

/** PCM16 WAV (mono, or stereo averaged) → floats in -1…1; null for anything else. */
export function decodeWav(bytes: Uint8Array): DecodedClip | null {
  if (bytes.length < 12) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let at = 12
  let rate = 0
  let channels = 0
  let bits = 0
  let format = 0
  while (at + 8 <= bytes.length) {
    const id = tag(at)
    const size = v.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = v.getUint16(body, true)
      channels = v.getUint16(body + 2, true)
      rate = v.getUint32(body + 4, true)
      bits = v.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || channels < 1 || channels > 2 || rate <= 0) return null
      // A streamed WAV may carry 0 or 0xFFFFFFFF as the size: take what's there.
      const end = size === 0 || body + size > bytes.length ? bytes.length : body + size
      const frames = Math.floor((end - body) / (2 * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += v.getInt16(body + (i * channels + c) * 2, true) / 32768
        samples[i] = sum / channels
      }
      return { samples, sampleRate: rate }
    }
    at = body + size + (size & 1)
  }
  return null
}

/** Linear fade-in over the first and fade-out over the last `seconds` (never more than half the clip each). */
export function fadeEdges(samples: Float32Array, sampleRate: number, seconds = FADE_SECONDS) {
  const n = Math.min(Math.floor(sampleRate * seconds), Math.floor(samples.length / 2))
  for (let i = 0; i < n; i++) {
    const gain = i / n
    samples[i]! *= gain
    samples[samples.length - 1 - i]! *= gain
  }
}

/**
 * Where each clip starts on the audio clock so they play back to back. A clip that arrives after
 * the queue ran dry starts a hair ahead of `now` (scheduling in the past would clip its start);
 * one that arrives while others play starts exactly where the last ends.
 */
export class PlaybackSchedule {
  private end = 0
  /** Clips scheduled and not yet finished. */
  private inFlight = 0
  private generation = 0

  private lead: number

  constructor(lead = 0.02) {
    this.lead = lead
  }

  get idle() {
    return this.inFlight === 0
  }

  /** Start time for a clip of `duration` seconds, and the token to complete it with. */
  add(now: number, duration: number): { at: number; token: number } {
    const at = Math.max(this.end, now + this.lead)
    this.end = at + duration
    this.inFlight++
    return { at, token: this.generation }
  }

  /** A clip ended. True when that was the last one queued (and not one from before a cut). */
  done(token: number) {
    if (token !== this.generation || this.inFlight === 0) return false
    this.inFlight--
    return this.inFlight === 0
  }

  cut() {
    this.generation++
    this.inFlight = 0
    this.end = 0
  }
}

export type BargeEvent = 'duck' | 'stop' | 'resume'

export interface BargeConfig {
  marginDb: number
  minDb: number
  duckSeconds: number
  stopSeconds: number
  resumeQuietSeconds: number
}

export const BARGE_DEFAULTS: BargeConfig = { marginDb: 14, minDb: -40, duckSeconds: 0.1, stopSeconds: 0.4, resumeQuietSeconds: 0.3 }

/**
 * Energy-based talk-over detector over the echo-cancelled microphone (kit `BargeInDetector`).
 *
 *  - duck: speech-level energy for `duckSeconds` (lowers the voice at once; costs nothing if wrong)
 * - stop: the same energy for `stopSeconds` (the voice is cut; the words that follow go out as the next message).
 *   Long on purpose: the loudspeaker's echo comes in syllable bursts and shouldn't add up to it.
 *  - resume: after a duck, `resumeQuietSeconds` of quiet means it was a cough or a click
 *
 * "Speech-level" is `marginDb` above a noise floor learned from the quiet frames (rises slowly,
 * falls quickly), never below `minDb`. The count is windowed: quiet frames take away twice their
 * length, so speech (mostly loud, short gaps) keeps climbing while echo bursts (loud about half the time) don't.
 */
export class BargeInDetector {
  floorDb = -60
  loudFor = 0
  quietFor = 0
  ducked = false
  stopped = false
  /** When the current burst of energy started (the caller's clock), for latency logs. */
  onsetAt: number | null = null
  // Frame durations add up in floating point (ten 10 ms frames are 0.0999…).
  private static EPS = 1e-6

  private config: BargeConfig

  constructor(config: BargeConfig = BARGE_DEFAULTS) {
    this.config = config
  }

  get thresholdDb() {
    return Math.max(this.floorDb + this.config.marginDb, this.config.minDb)
  }

  /** `armed`: the voice is playing, so talking over it means something. Unarmed frames still teach the floor. */
  feed(db: number, seconds: number, now: number, armed: boolean): BargeEvent | null {
    const loud = db > this.thresholdDb
    if (!loud) this.learnFloor(db)
    if (!armed) {
      this.loudFor = 0
      this.quietFor = 0
      this.ducked = false
      this.stopped = false
      this.onsetAt = null
      return null
    }
    const { stopSeconds, duckSeconds, resumeQuietSeconds } = this.config
    const eps = BargeInDetector.EPS
    if (loud) {
      if (this.loudFor === 0) this.onsetAt = now
      this.loudFor += seconds
      this.quietFor = 0
      if (this.loudFor + eps >= stopSeconds && !this.stopped) {
        this.stopped = true
        return 'stop'
      }
      if (this.loudFor + eps >= duckSeconds && !this.ducked && !this.stopped) {
        this.ducked = true
        return 'duck'
      }
      return null
    }
    this.quietFor += seconds
    this.loudFor = Math.max(0, this.loudFor - 2 * seconds)
    if (this.quietFor + eps < resumeQuietSeconds || this.stopped) return null
    this.onsetAt = null
    if (this.ducked) {
      this.ducked = false
      return 'resume'
    }
    return null
  }

  private learnFloor(db: number) {
    const alpha = db < this.floorDb ? 0.25 : 0.02
    this.floorDb = Math.min(-35, Math.max(-80, this.floorDb + (db - this.floorDb) * alpha))
  }
}

/** The speech helper's level (0…1 over -50…0 dB) back as dBFS. */
export const levelToDb = (level: number) => level * 50 - 50
