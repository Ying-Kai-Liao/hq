import type { SpeechEvent } from '@shared/ipc'
import { stopDictation } from '../thread/dictation'
import { onDeviceUnavailableReason, spokenText, VoiceEngine, VoiceSettings } from './voice'

/**
 * The reply's language from its script, for picking a voice (replies may be English while the
 * computer is in Chinese).
 * ponytail: script counting, not NLLanguageRecognizer; misreads Latin-script languages other than the system's.
 */
function languageOf(text: string): string {
  const count = (re: RegExp) => text.match(re)?.length ?? 0
  const latin = count(/[A-Za-z]/g)
  const system = navigator.language
  if (count(/[぀-ヿ]/g) > 0) return 'ja'
  if (count(/[가-힯]/g) > latin / 3) return 'ko'
  if (count(/\p{Script=Han}/gu) > latin / 3) {
    const chinese = navigator.languages.find((l) => l.startsWith('zh'))
    if (chinese) return /Hant|TW|HK|MO/.test(chinese) ? (/HK/.test(chinese) ? 'zh-HK' : 'zh-TW') : 'zh-CN'
    return 'zh-TW'
  }
  return /^(zh|ja|ko)/.test(system) ? 'en' : system.split('-')[0]!
}

/** A system voice in the text's language: the computer's own region first, then local voices. */
function voiceFor(text: string): SpeechSynthesisVoice | null {
  const code = languageOf(text)
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith(code))
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang.replace('_', '-') === navigator.language ? 4 : 0) + (/premium|enhanced/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0)
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null
}

/**
 * A hands-free voice loop with one bot, all on this computer: speech is transcribed on device
 * (SFSpeechRecognizer in the speech helper), sent as an ordinary message, and the bot's final
 * replies are read aloud with the system voices. The host sees text only.
 */
export class OnDeviceEngine extends VoiceEngine {
  readonly provider = null
  /** What you're saying right now. */
  private heard = ''
  /** A recognition is running (between our start and stop). */
  private recognizing = false
  /** The helper said it's listening (permissions granted). */
  private started = false
  private everStarted = false
  private lastRestart = 0
  private silence: ReturnType<typeof setTimeout> | null = null
  private offEvents: (() => void) | null = null
  protected speakGeneration = 0
  /** The microphone stays on while the voice speaks, so the user can talk over it (needs echo cancellation). */
  protected talkOverEnabled = false

  constructor(private send: (text: string) => void) {
    super()
  }

  async start() {
    if (!window.kith.speech.available) return this.fail(onDeviceUnavailableReason())
    // The call takes the recognizer from any dictation in progress.
    stopDictation()
    speechSynthesis.getVoices()
    this.offEvents = window.kith.speech.onEvent((e) => this.event(e))
    this.listen()
  }

  end() {
    this.ended = true
    this.onActivityChanged?.(false)
    this.stopListening()
    this.offEvents?.()
    this.offEvents = null
    this.speakGeneration++
    speechSynthesis.cancel()
  }

  protected mutedChanged(on: boolean) {
    if (this.phase !== 'listening' && !(this.phase === 'speaking' && this.talkOverEnabled)) return
    if (on) this.stopListening()
    else this.restartListening()
  }

  /** Reads a reply aloud (the bot's final message), pausing the microphone meanwhile. */
  speak(markdown: string) {
    const text = spokenText(markdown)
    if (this.ended || !text || this.phase === 'starting' || this.phase === 'failed') return
    this.stopListening()
    this.captions.said(text)
    this.setPhase('speaking')
    const generation = ++this.speakGeneration
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = voiceFor(text)
    if (voice) {
      utterance.voice = voice
      utterance.lang = voice.lang
    }
    // The Mac stores AVSpeechUtterance's rate (0.5 normal); the web's normal is 1.
    const rate = VoiceSettings.rate()
    utterance.rate = rate > 0 ? Math.min(10, Math.max(0.1, rate / 0.5)) : 1
    utterance.onend = () => generation === this.speakGeneration && this.finishedSpeaking()
    utterance.onerror = () => generation === this.speakGeneration && this.finishedSpeaking()
    speechSynthesis.speak(utterance)
  }

  announce(notice: string) {
    this.speak(notice)
  }

  /** Cuts the reply short and goes back to listening. */
  interrupt() {
    if (this.phase !== 'speaking') return
    this.speakGeneration++
    speechSynthesis.cancel()
    this.captions.settleBot()
    this.listen()
  }

  // MARK: listening

  protected listen() {
    if (this.phase !== 'listening' && this.everStarted) this.setPhase('listening')
    this.restartListening()
  }

  /** A fresh recognition without changing the phase (a new utterance, or the mic kept on while speaking). */
  protected restartListening() {
    this.heard = ''
    if (this.muted || this.ended) return
    this.recognizing = true
    this.started = false
    window.kith.speech.start(VoiceSettings.language() || null, this.talkOverEnabled ? { echoCancel: true } : undefined)
  }

  /** The microphone is listening (a recognition is running). */
  protected get micOn() {
    return this.recognizing
  }

  /** Every microphone level report (0…1 over -50…0 dB, echo-cancelled when talk-over is on), for energy-based talk-over. */
  protected micLevel(_level: number) {}

  /** The transcript as the user's words (a subclass drops the bot's own voice from it). */
  protected heardText(text: string) {
    return text
  }

  /** Words heard while the voice speaks: true if the user is talking over it (the subclass has then cut the voice). */
  protected talkOver(_text: string) {
    return false
  }

  protected stopListening() {
    if (this.silence) clearTimeout(this.silence)
    this.silence = null
    if (this.recognizing) window.kith.speech.stop()
    this.recognizing = false
    this.started = false
    this.level = 0
  }

  private event(e: SpeechEvent) {
    if (this.ended || !this.recognizing) return
    switch (e.type) {
      case 'started':
        this.started = true
        if (!this.everStarted) {
          this.everStarted = true
          this.setPhase('listening')
        }
        break
      case 'level':
        if (this.phase === 'listening' || this.phase === 'speaking') this.level = e.value
        this.micLevel(e.value)
        break
      case 'partial':
      case 'final':
        this.recognized(e.text, e.type === 'final')
        break
      case 'error':
        // Before it listened: permissions or no recognizer for the language.
        if (!this.started) return this.fail(e.message)
        this.restart(e.message)
        break
      case 'stopped':
        if (!this.started) return this.fail("Speech recognition stopped.")
        this.restart('Speech recognition stopped.')
        break
    }
  }

  /** The helper gave up mid-utterance: send what was heard and listen again, unless it keeps failing. */
  private restart(message: string) {
    if (Date.now() - this.lastRestart < 1000) return this.fail(message)
    this.lastRestart = Date.now()
    this.submit()
  }

  private recognized(text: string, final: boolean) {
    const words = this.heardText(text)
    if (this.phase === 'speaking') {
      if (!this.talkOver(words)) {
        // The recognizer ended on the bot's own voice: start another.
        if (final) this.restartListening()
        return
      }
    }
    if (this.phase !== 'listening') return
    if (!words.trim()) {
      // Only the bot's tail coming back.
      if (final) this.submit()
      return
    }
    this.heard = words
    this.captions.hearing(words)
    this.changed()
    if (this.silence) clearTimeout(this.silence)
    if (final) return this.submit()
    this.silence = setTimeout(() => this.submit(), VoiceSettings.pause() * 1000)
  }

  private submit() {
    const text = this.heard.trim()
    this.stopListening()
    this.captions.settleYou()
    if (text) this.send(text)
    // Keep listening while the bot works: more messages fold into its next turn.
    if (this.phase === 'speaking') this.restartListening()
    else this.listen()
  }

  protected finishedSpeaking() {
    if (this.phase !== 'speaking') return
    this.captions.settleBot()
    this.listen()
  }

  protected fail(message: string) {
    this.stopListening()
    this.failure = message
    this.setPhase('failed')
  }
}
