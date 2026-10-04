import { isWorking } from '@shared/models'
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { Sheet } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useModel } from '../../lib/observable'
import { avatarColor, useDark, useReduceMotion, withAlpha } from '../../lib/theme'
import { useStore } from '../../store/context'
import { VoiceChatSettingsView } from '../settings/VoiceChatSettingsView'
import { CallOperator } from './call-operator'
import { CloudSpeechEngine } from './CloudSpeechEngine'
import { GeminiLiveEngine } from './GeminiLiveEngine'
import { OnDeviceEngine } from './OnDeviceEngine'
import { OpenAIRealtimeEngine } from './OpenAIRealtimeEngine'
import { countVoiceUsage, fromBase64, onDeviceAvailable, onDeviceUnavailableReason, providerName, toBase64, VoiceEngine, VoiceSettings, type VoiceProvider, type VoiceStatus } from './voice'
import { watchVoiceCall } from './voice-call'
import './call.css'

/**
 * A voice call with a bot, as Grok Bot does it: a floating bar over the chat, which stays
 * readable underneath. What you say goes out as ordinary messages, its final replies are read
 * aloud, and the chat gets a "Voice chat · 00:16" line when the call ends.
 */
export function CallView({ botId, onSpeaking, interrupt, onEnd }: {
  botId: string
  onSpeaking: (speaking: boolean) => void
  interrupt: { current: (() => void) | null }
  onEnd: () => void
}) {
  const store = useStore()
  const [session, setSession] = useState<VoiceEngine | null>(null)
  useModel(session)
  /** One line under the bar, e.g. why the call fell back to another voice. */
  const [notice, setNotice] = useState<string | null>(null)
  /** No engine could start at all. */
  const [blocked, setBlocked] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const engine = useRef<VoiceEngine | null>(null)
  /** When the current cloud engine started, for this month's minutes. */
  const cloudStartedAt = useRef<number | null>(null)
  const closed = useRef(false)
  const bot = store.bots.get(botId)
  const color = bot ? avatarColor(bot.avatarColor) : null

  const countCloudMinutes = () => {
    const provider = engine.current?.provider
    if (!provider || cloudStartedAt.current === null) return
    countVoiceUsage((Date.now() - cloudStartedAt.current) / 1000, provider)
    cloudStartedAt.current = null
  }

  const credential = (provider: VoiceProvider, model: string, voice: string) => async () => {
    const client = await store.ready()
    return (await client.call<{ credential: string }>('voiceSession', { provider, model, voice }, 30_000)).credential
  }

  /** Starts the engine: a realtime provider on the key kept by the computer, or on-device speech. */
  const begin = (provider: VoiceProvider | null) => {
    if (closed.current) return
    if (!provider && !onDeviceAvailable()) return void fallbackFromDevice()
    const op = new CallOperator(store, botId)
    const send = (text: string) => store.send(text, botId)
    let next: VoiceEngine
    if (provider && VoiceSettings.isSpeechMode(provider)) {
      const transcribe = VoiceSettings.transcribeModel(provider)
      const speechModel = VoiceSettings.speechModel(provider)
      const voice = VoiceSettings.voice(provider)
      next = new CloudSpeechEngine(provider, {
        // ponytail: kit turns Simplified Chinese transcripts into Traditional (ICU Hans-Hant); Chromium has no such transform.
        transcribe: async (audio) =>
          (await (await store.ready()).call<{ text: string }>('voiceTranscribe', { provider, model: transcribe, audio: toBase64(audio) }, 60_000)).text,
        speak: async (text) => {
          const clip = await (await store.ready()).call<{ audio: string; format: string }>('voiceSpeak', { provider, model: speechModel, voice, text }, 90_000)
          return { audio: fromBase64(clip.audio), format: clip.format }
        },
        send,
      })
      cloudStartedAt.current = Date.now()
    } else if (provider) {
      const model = VoiceSettings.model(provider)
      const voice = VoiceSettings.voice(provider)
      next =
        provider === 'openai'
          ? new OpenAIRealtimeEngine(credential(provider, model, voice), op)
          : new GeminiLiveEngine(model, voice, credential(provider, model, voice), op)
      cloudStartedAt.current = Date.now()
    } else {
      next = new OnDeviceEngine(send)
    }
    // Picks up the computer's newest models for the next call; this one starts right away.
    if (provider) void rememberStatus()
    let stopWatching: (() => void) | null = null
    next.onActivityChanged = (active) => {
      if (active && !stopWatching) {
        stopWatching = watchVoiceCall(store, botId, { speak: (t) => next.speak(t), announce: (t) => next.announce(t) })
      } else if (!active && stopWatching) {
        stopWatching()
        stopWatching = null
      }
    }
    engine.current = next
    setSession(next)
    void next.start()
  }

  const rememberStatus = async () => {
    try {
      const status = await (await store.ready()).call<VoiceStatus>('voiceStatus')
      VoiceSettings.remember(status)
      return status
    } catch {
      return null
    }
  }

  /** No on-device speech here (Linux, or a build without the helper): use a provider with a key, if any. */
  const fallbackFromDevice = async () => {
    const configured = (await rememberStatus())?.providers.find((p) => p.configured)?.provider
    if (closed.current) return
    if (configured) {
      setNotice(`${onDeviceUnavailableReason()} Using ${providerName(configured)}.`)
      begin(configured)
    } else {
      setBlocked(`${onDeviceUnavailableReason()} Add an OpenAI or Gemini key in call settings.`)
    }
  }

  useEffect(() => {
    const startedAt = Date.now()
    begin(VoiceSettings.provider())
    return () => {
      closed.current = true
      engine.current?.end()
      countCloudMinutes()
      onSpeaking(false)
      interrupt.current = null
      store.logCall(botId, Math.floor((Date.now() - startedAt) / 1000))
    }
  }, [])

  const phase = session?.phase ?? null
  useEffect(() => {
    if (!session) return
    onSpeaking(phase === 'speaking')
    interrupt.current = phase === 'speaking' ? () => session.interrupt() : null
    // A cloud engine that can't start or drops mid-call hands over to on-device voice.
    if (phase === 'failed' && session.provider && onDeviceAvailable()) {
      countCloudMinutes()
      setNotice(`${providerName(session.provider)} isn't available (${session.failure}). Using on-device voice.`)
      begin(null)
    }
  }, [session, phase])

  const speaking = phase === 'speaking'
  const muted = session?.muted === true
  const working = bot ? isWorking(bot) : false
  const statusText =
    phase === null || phase === 'starting'
      ? 'Connecting'
      : phase === 'speaking'
        ? 'Speaking'
        : phase === 'failed'
          ? "Can't listen"
          : muted
            ? 'Muted'
            : working
              ? 'Working, listening'
              : 'Listening'
  const failure = blocked ?? (phase === 'failed' ? session?.failure : null)

  return (
    <div className="call">
      <div className="call-bar">
        <button
          className={`call-avatar ${speaking ? 'speaking' : ''}`}
          disabled={!speaking}
          aria-label={speaking ? 'Interrupt' : (bot?.name ?? '')}
          title={speaking ? 'Interrupt' : undefined}
          onClick={() => session?.interrupt()}
        >
          {bot ? <BotAvatar bot={bot} size={34} /> : <span style={{ width: 34, height: 34 }} />}
        </button>
        <CallLevelDots engine={session} working={working} color={color} label={statusText} />
        {/* Audio leaves the computer: say where. */}
        {session?.provider ? (
          <span style={{ ...font('caption2', 'semibold'), color: 'var(--secondary)' }} aria-label={`Voice by ${providerName(session.provider)}`}>
            {providerName(session.provider)}
          </span>
        ) : null}
        <button className="call-round" title="Call settings" aria-label="Call settings" onClick={() => setSettings(true)}>
          <Icon name="gearshape" size={16} weight="medium" scaled={false} />
        </button>
        <button
          className={`call-round ${muted ? 'on' : ''}`}
          title={muted ? 'Unmute' : 'Mute'}
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={() => session && (session.muted = !session.muted)}
        >
          <Icon name={muted ? 'mic.slash' : 'mic'} size={16} weight="medium" scaled={false} />
        </button>
        <button className="call-round end" title="End call" aria-label="End call" onClick={onEnd}>
          <Icon name="xmark" size={16} weight="semibold" scaled={false} />
        </button>
      </div>
      {failure ? (
        <div key="failure" className="call-line" style={{ color: 'var(--danger)' }}>
          {failure}
        </div>
      ) : notice ? (
        <div key={notice} className="call-line" style={{ color: 'var(--secondary)' }}>
          {notice}
        </div>
      ) : null}
      <Sheet open={settings} onClose={() => setSettings(false)}>
        <VoiceChatSettingsView />
      </Sheet>
    </div>
  )
}

const DOTS_WIDTH = 120
const DOTS_HEIGHT = 16

/**
 * The dotted line in the call bar: it follows your voice while listening, ripples while the bot
 * talks, breathes while it works, and rests as faint dots otherwise.
 */
function CallLevelDots({ engine, working, color, label }: { engine: VoiceEngine | null; working: boolean; color: string | null; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dark = useDark()
  const reduceMotion = useReduceMotion()
  const live = useRef({ engine, working, color, dark, reduceMotion })
  live.current = { engine, working, color, dark, reduceMotion }

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const scale = window.devicePixelRatio || 1
    el.width = DOTS_WIDTH * scale
    el.height = DOTS_HEIGHT * scale
    let frame = 0
    const draw = (now: number) => {
      const { engine, working, color, dark, reduceMotion } = live.current
      const t = reduceMotion ? 0 : now / 1000
      const speaking = engine?.phase === 'speaking'
      const level = engine?.level ?? 0
      const accent = dark ? '#ffffff' : '#000000'
      const tint = speaking ? accent : (color ?? accent)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.clearRect(0, 0, DOTS_WIDTH, DOTS_HEIGHT)
      const spacing = 8
      const count = Math.max(1, Math.floor(DOTS_WIDTH / spacing))
      for (let i = 0; i < count; i++) {
        const x = i * spacing + spacing / 2
        const wave = (Math.sin(i * 0.55 - t * 6) + 1) / 2
        const amount = speaking ? 0.5 + 0.5 * wave : level > 0.05 ? Math.max(0.2, level) * (0.45 + 0.55 * wave) : working ? 0.25 * ((Math.sin(t * 2.4) + 1) / 2) : 0.08
        const height = 4 + amount * (DOTS_HEIGHT - 4)
        ctx.fillStyle = withAlpha(tint, 0.5 + 0.5 * amount)
        ctx.beginPath()
        ctx.roundRect(x - 1.25, (DOTS_HEIGHT - height) / 2, 2.5, height, 1.25)
        ctx.fill()
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  return <canvas ref={canvas} role="img" aria-label={label} style={{ width: DOTS_WIDTH, height: DOTS_HEIGHT, flex: 'none' }} />
}
