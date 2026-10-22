import { OnDeviceEngine } from './OnDeviceEngine'
import { ClipQueue, clips } from './speech-clips'
import { errorMessage, spokenText } from './voice'
import type { LocalVoiceStatus } from '../settings/voice-settings'

export interface KithVoiceHost {
  status: () => Promise<LocalVoiceStatus>
  /** Starts the model download. */
  prepare: () => Promise<LocalVoiceStatus>
  /** One clip of WAV audio. */
  speak: (text: string, voice?: string) => Promise<Uint8Array>
  voice: (status: LocalVoiceStatus) => string | undefined
}

/** A reply is spoken a sentence or two at a time, so the first words come early. */
const CLIP_CHARS = 160

/**
 * "Kith voice": listening is the on-device engine's (Apple speech); speaking is Phonon text to
 * speech run by the computer's kith serve, fetched clip by clip. Free, and nothing leaves the Macs.
 */
export class KithVoiceEngine extends OnDeviceEngine {
  private voiceName: string | undefined
  private player: HTMLAudioElement | null = null
  private stopPlayer: (() => void) | null = null
  private queue: ClipQueue<Uint8Array>

  constructor(
    send: (text: string) => void,
    private host: KithVoiceHost,
  ) {
    super(send)
    this.queue = new ClipQueue((text) => this.fetchClip(text))
  }

  async start() {
    try {
      let status = await this.host.status()
      if (this.ended) return
      if (!status.available) return this.fail("Kith voice isn't available on this computer.")
      this.voiceName = this.host.voice(status)
      if (status.state !== 'ready') {
        // The download runs while the call listens; the first reply waits for it.
        this.setWarning('Downloading voice…')
        status = await this.host.prepare()
        if (status.state === 'error') this.setWarning(status.error ?? "The voice couldn't be downloaded.")
      }
    } catch (e) {
      if (this.ended) return
      return this.fail(`Kith voice needs a newer Kith on this computer (${errorMessage(e)}). Pick another engine in call settings.`)
    }
    if (this.ended) return
    await super.start()
  }

  end() {
    super.end()
    this.stopSpeech()
  }

  speak(markdown: string) {
    const text = spokenText(markdown)
    if (this.ended || !text || this.phase === 'starting' || this.phase === 'failed') return
    this.stopListening()
    this.setPhase('speaking')
    this.stopSpeech()
    const generation = ++this.speakGeneration
    this.queue.add(clips(text, CLIP_CHARS))
    void this.pump(generation)
  }

  interrupt() {
    if (this.phase !== 'speaking') return
    this.speakGeneration++
    this.stopSpeech()
    this.listen()
  }

  private async pump(generation: number) {
    for (;;) {
      const clip = await this.queue.take()
      if (generation !== this.speakGeneration || this.ended) return
      if (!clip) break
      await this.play(clip, generation)
      if (generation !== this.speakGeneration || this.ended) return
    }
    this.finishedSpeaking()
  }

  private async fetchClip(text: string): Promise<Uint8Array | null> {
    try {
      const audio = await this.host.speak(text, this.voiceName)
      this.setWarning(null)
      return audio
    } catch (e) {
      console.error('kith voice:', errorMessage(e))
      // The call goes on listening; the reply is on screen.
      this.setWarning(`Couldn't speak the reply (${errorMessage(e)}).`)
      return null
    }
  }

  /** Resolves when the clip ends, fails to play, or playback is stopped. */
  private play(audio: Uint8Array, generation: number) {
    return new Promise<void>((resolve) => {
      if (generation !== this.speakGeneration) return resolve()
      const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/wav' }))
      const player = new Audio(url)
      const done = () => {
        if (this.player === player) {
          this.player = null
          this.stopPlayer = null
        }
        player.onended = null
        player.onerror = null
        URL.revokeObjectURL(url)
        resolve()
      }
      player.onended = done
      player.onerror = () => {
        console.error('kith voice: unreadable clip')
        done()
      }
      this.player = player
      this.stopPlayer = () => {
        player.pause()
        done()
      }
      void player.play().catch(() => player.onerror?.(new Event('error')))
    })
  }

  private stopSpeech() {
    this.queue.stop()
    this.stopPlayer?.()
  }
}
