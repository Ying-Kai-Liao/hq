import { OnDeviceEngine } from './OnDeviceEngine'
import { ClipQueue, clips } from './speech-clips'
import { isEcho, SentenceStream, shouldCue, stripEcho, wordCount } from './speech-stream'
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
 *
 * A reply is spoken while it is still being written: each finished sentence goes into the clip
 * queue once. The microphone stays on while it speaks (echo-cancelled), and talking over the voice
 * stops it at once; the turn goes on and what was said is sent as the next message.
 */
export class KithVoiceEngine extends OnDeviceEngine {
  override readonly streamsReplies = true
  override readonly canChooseOutput = true
  private sinkId = ''
  private voiceName: string | undefined
  private player: HTMLAudioElement | null = null
  private stopPlayer: (() => void) | null = null
  private queue: ClipQueue<Uint8Array>
  private stream = new SentenceStream()
  /** A clip is playing or about to (the pump is running). */
  private pumping = false
  /** What was said since the user last spoke: the microphone hears it back, and it isn't the user. */
  private echoRef = ''
  private working = false
  private sentAt: number | null = null
  private lastSpokenAt = 0
  private cued = false
  private cueTimer: ReturnType<typeof setInterval> | null = null
  private firstEnqueuedAt: number | null = null

  constructor(
    send: (text: string) => void,
    private host: KithVoiceHost,
  ) {
    super((text) => {
      this.sentAt = Date.now()
      this.cued = false
      this.firstEnqueuedAt = null
      send(text)
    })
    this.talkOverEnabled = true
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
    if (this.ended) return
    this.cueTimer = setInterval(() => this.cue(), 1000)
  }

  end() {
    super.end()
    if (this.cueTimer) clearInterval(this.cueTimer)
    this.cueTimer = null
    this.cutVoice()
  }

  override async setOutputDevice(deviceId: string) {
    this.sinkId = deviceId
    await this.applySink(this.player)
  }

  private async applySink(player: HTMLAudioElement | null) {
    // setSinkId is Chromium's; '' goes back to the system default.
    const sink = player as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
    try {
      await sink?.setSinkId?.(this.sinkId)
    } catch (e) {
      this.setWarning(`Couldn't switch the speaker (${errorMessage(e)}).`)
    }
  }

  setWorking(working: boolean) {
    this.working = working
  }

  /** A notice, or a whole reply from a watcher that doesn't stream: said after what's queued. */
  speak(markdown: string) {
    this.enqueue(spokenText(markdown))
  }

  announce(notice: string) {
    this.enqueue(notice)
  }

  streamReply(id: string, text: string, final: boolean) {
    const ready = this.stream.feed(id, text, final)
    if (ready) this.enqueue(ready)
    else if (final) this.finishedSpeaking()
  }

  /** Tap or Stop: the voice stops, the mic is already listening. */
  interrupt() {
    if (this.phase !== 'speaking') return
    this.cutVoice()
    this.finishedSpeaking()
  }

  protected heardText(text: string) {
    return stripEcho(text, this.echoRef)
  }

  protected talkOver(words: string) {
    // Two words or more that aren't the bot's own voice coming back through the speakers.
    if (wordCount(words) < 2 || isEcho(words, this.echoRef)) return false
    this.cutVoice()
    this.setPhase('listening')
    console.info('kith voice: talked over, voice stopped')
    return true
  }

  protected listen() {
    // A new utterance: whatever the bot said before is no longer in the transcript.
    this.echoRef = ''
    super.listen()
  }

  /** Nothing left to say for now; the microphone goes on listening (it never stopped). */
  protected finishedSpeaking() {
    if (this.phase !== 'speaking' || this.pumping || this.queue.pending) return
    this.captions.settleBot()
    if (this.micOn) this.setPhase('listening')
    else this.listen()
  }

  private enqueue(text: string) {
    const said = text.trim()
    if (this.ended || !said || this.phase === 'starting' || this.phase === 'failed') return
    this.queue.add(clips(said, CLIP_CHARS))
    this.echoRef += ` ${said}`
    this.captions.said(said)
    this.changed()
    this.lastSpokenAt = Date.now()
    this.firstEnqueuedAt ??= performance.now()
    if (this.phase !== 'speaking') this.setPhase('speaking')
    if (!this.pumping) {
      this.pumping = true
      void this.pump(this.speakGeneration)
    }
  }

  private cue() {
    const now = Date.now()
    if (!shouldCue({ now, sentAt: this.sentAt, lastSpokenAt: this.lastSpokenAt, working: this.working, cued: this.cued })) return
    this.cued = true
    this.enqueue('Working on it.')
  }

  private async pump(generation: number) {
    for (;;) {
      const clip = await this.queue.take()
      if (generation !== this.speakGeneration || this.ended) return
      if (!clip) break
      await this.play(clip, generation)
      if (generation !== this.speakGeneration || this.ended) return
    }
    // A clip that couldn't be made drops the rest of this stretch of speech.
    this.queue.stop()
    this.pumping = false
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
      if (this.sinkId) void this.applySink(player)
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
      void player
        .play()
        .then(() => {
          if (this.firstEnqueuedAt !== null) {
            console.info(`kith voice: first clip playing ${Math.round(performance.now() - this.firstEnqueuedAt)} ms after its text was ready`)
            this.firstEnqueuedAt = null
          }
        })
        .catch(() => player.onerror?.(new Event('error')))
    })
  }

  /** Stops the voice, drops queued clips, and gives up what's still being written of the replies on air. */
  private cutVoice() {
    this.speakGeneration++
    this.stream.muteOpen()
    this.pumping = false
    this.queue.stop()
    this.stopPlayer?.()
    this.captions.settleBot()
  }
}
