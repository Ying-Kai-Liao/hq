import { BARGE_DEFAULTS, BargeInDetector, levelToDb, type BargeEvent } from './audio-chain'
import { ClipPlayer } from './clip-player'
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
 *
 * Talk-over is two signals. Energy on the echo-cancelled microphone (`BargeInDetector`) ducks the
 * voice after ~100 ms of speech-level sound; two recognized words that
 * aren't the bot's own text also cut it, and so does ~400 ms of sustained energy. A duck that isn't followed by more sound (a cough) is
 * undone after ~300 ms of quiet.
 */
export class KithVoiceEngine extends OnDeviceEngine {
  override readonly streamsReplies = true
  override readonly canChooseOutput = true
  private voiceName: string | undefined
  private player = new ClipPlayer()
  private bargeIn = new BargeInDetector({
    ...BARGE_DEFAULTS,
    // A tuning knob for rooms where the default misfires (dB above the noise floor).
    marginDb: Number(localStorage.getItem('callBargeMarginDb')) || BARGE_DEFAULTS.marginDb,
  })
  private lastLevelAt = 0
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
    this.player.onSinkLost = (e) => this.setWarning(`Couldn't use that speaker (${errorMessage(e)}); using the default.`)
    this.player.onDrained = () => {
      this.finishedSpeaking()
    }
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
    this.player.close()
  }

  override async setOutputDevice(deviceId: string) {
    try {
      await this.player.setSink(deviceId)
    } catch (e) {
      this.setWarning(`Couldn't switch the speaker (${errorMessage(e)}).`)
    }
  }

  /** Energy on the microphone while the voice plays (see `BargeInDetector`). */
  protected override micLevel(level: number) {
    const now = performance.now()
    // Reports come ~20 a second, each the loudness of one short buffer: it stands for the time since the last.
    // The first report after a gap stands for one buffer, not the whole silence.
    const gap = (now - this.lastLevelAt) / 1000
    const seconds = this.lastLevelAt && gap < 0.25 ? Math.min(0.1, gap) : 0.05
    this.lastLevelAt = now
    const armed = this.phase === 'speaking' && !this.player.idle
    const event = this.bargeIn.feed(levelToDb(level), seconds, now, armed)
    if (event) this.bargeInEvent(event, this.bargeIn.onsetAt ?? now)
  }

  private bargeInEvent(event: BargeEvent, onset: number) {
    const since = () => Math.round(performance.now() - onset)
    switch (event) {
      case 'duck':
        this.player.duck(true)
        console.info(`kith voice: talk-over: voice ducked ${since()} ms after the first loud report`)
        break
      case 'resume':
        this.player.duck(false)
        console.info('kith voice: talk-over: false alarm, voice back up')
        break
      case 'stop':
        this.cutVoice()
        this.setPhase('listening')
        console.info(`kith voice: talk-over: voice stopped ${since()} ms after the first loud report`)
        break
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
    console.info('kith voice: talk-over: words heard, voice stopped')
    return true
  }

  protected listen() {
    // A new utterance: whatever the bot said before is no longer in the transcript.
    this.echoRef = ''
    super.listen()
  }

  /** Nothing left to say for now; the microphone goes on listening (it never stopped). */
  protected finishedSpeaking() {
    if (this.phase !== 'speaking' || this.pumping || this.queue.pending || !this.player.idle) return
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
      // Queued behind what's playing, not awaited: the next clip is on the audio clock before this one ends.
      await this.play(clip)
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

  private async play(audio: Uint8Array) {
    // A clip that can't be played is skipped; the pump goes on.
    try {
      const ok = await this.player.add(audio, () => {
        if (this.firstEnqueuedAt !== null) {
          console.info(`kith voice: first clip playing ${Math.round(performance.now() - this.firstEnqueuedAt)} ms after its text was ready`)
          this.firstEnqueuedAt = null
        }
      })
      if (!ok) console.error('kith voice: unreadable clip')
    } catch (e) {
      console.error('kith voice: playback failed:', errorMessage(e))
      this.setWarning(`Couldn't play the reply (${errorMessage(e)}).`)
    }
  }

  /** Stops the voice, drops queued clips, and gives up what's still being written of the replies on air. */
  private cutVoice() {
    this.speakGeneration++
    this.stream.muteOpen()
    this.pumping = false
    this.queue.stop()
    this.player.stop()
    this.captions.settleBot()
  }
}
