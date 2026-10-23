import type { Bot } from '@shared/models'
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { avatarColor, useReduceMotion } from '../../lib/theme'
import type { CaptionLine } from './transcript'
import { errorMessage, providerName, type VoiceEngine } from './voice'

interface OutputDevice {
  id: string
  label: string
}

/** m:ss of the call so far. */
function useElapsed() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The call, full size over the chat: the bot's living avatar with a ring that follows your voice
 * and pulses while the bot talks, the call's state, the live transcript, and the controls.
 * The engine and its lifetime belong to `CallView`; this only draws and presses.
 */
export function CallScreen({ bot, session, statusText, failure, notice, working, onSettings, onEnd }: {
  bot: Bot | undefined
  session: VoiceEngine | null
  statusText: string
  failure: string | null
  notice: string | null
  working: boolean
  onSettings: () => void
  onEnd: () => void
}) {
  useModel(session)
  const elapsed = useElapsed()
  const speaking = session?.phase === 'speaking'
  const muted = session?.muted === true
  const warning = session?.warning ?? null
  const lines = session?.captions.lines ?? []
  const color = bot ? avatarColor(bot.avatarColor) : null

  return (
    <div className="call-screen" role="dialog" aria-label={`Voice call with ${bot?.name ?? 'bot'}`}>
      <div className="call-screen-drag" />
      <div className="call-screen-main">
        <button
          className={`call-screen-avatar ${speaking ? 'speaking' : ''} ${working ? 'working' : ''}`}
          disabled={!speaking}
          aria-label={speaking ? 'Interrupt' : (bot?.name ?? '')}
          title={speaking ? 'Tap to interrupt' : undefined}
          onClick={() => session?.interrupt()}
        >
          <LevelRing engine={session} color={color} />
          {bot ? <BotAvatar bot={bot} size={132} /> : <span className="call-screen-avatar-empty" />}
        </button>
        <Text size="title" weight="semibold" tone="text" className="call-screen-name">{bot?.name ?? ''}</Text>
        <Text as="div" size="body" tone={failure ? 'danger' : 'secondary'} className="call-screen-state" aria-live="polite">
          {failure ?? statusText}
        </Text>
        <Text size="caption" tone="secondary" tabular>
          {elapsed}
          {session?.provider ? ` · Voice by ${providerName(session.provider)}` : ''}
        </Text>
        {!failure && (warning || notice) ? (
          <Text as="div" key={warning ?? notice} size="caption" tone="secondary" className="call-line">
            {warning ?? notice}
          </Text>
        ) : null}
      </div>
      <Transcript lines={lines} started={!!session && !failure} hasCaptions={!!session && session.provider === null} />
      <div className="call-screen-controls">
        <button className="call-round big" title="Call settings" aria-label="Call settings" onClick={onSettings}>
          <Icon name="gearshape" size={20} weight="medium" scaled={false} />
        </button>
        <SpeakerButton engine={session} />
        <button
          className={`call-round big ${muted ? 'on' : ''}`}
          title={muted ? 'Unmute' : 'Mute'}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          onClick={() => session && (session.muted = !session.muted)}
        >
          <Icon name={muted ? 'mic.slash' : 'mic'} size={20} weight="medium" scaled={false} />
        </button>
        <button className="call-round big end" title="End call" aria-label="End call" onClick={onEnd}>
          <Icon name="phone.down.fill" size={20} weight="semibold" scaled={false} />
        </button>
      </div>
    </div>
  )
}

/** A halo around the avatar, sized by the microphone level every frame (no React renders). */
function LevelRing({ engine, color }: { engine: VoiceEngine | null; color: string | null }) {
  const ring = useRef<HTMLSpanElement>(null)
  const reduce = useReduceMotion()
  const live = useRef(engine)
  live.current = engine
  useEffect(() => {
    if (reduce) return
    let frame = 0
    const tick = () => {
      const e = live.current
      const level = e && e.phase === 'listening' && !e.muted ? e.level : 0
      ring.current?.style.setProperty('--level', level.toFixed(3))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reduce])
  return <span ref={ring} aria-hidden className="call-screen-ring" style={color ? { ['--ring' as string]: color } : undefined} />
}

/** What was said, newest at the bottom: your words as the recognizer hears them, the bot's as it speaks them. */
function Transcript({ lines, started, hasCaptions }: { lines: CaptionLine[]; started: boolean; hasCaptions: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  const text = lines.map((l) => l.text).join('\n')
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [text])
  return (
    <div className="call-captions" aria-label="Transcript">
      {lines.length === 0 && started ? (
        <Text as="div" size="caption" tone="secondary" className="call-captions-empty">
          {hasCaptions ? 'What you say and what the bot says shows up here.' : 'Live captions are available with Kith voice and on-device voice.'}
        </Text>
      ) : null}
      {lines.map((l) => (
        <div key={l.id} className={`call-caption ${l.who} ${l.live ? 'live' : ''}`}>
          <Text size="compactBody" tone={l.who === 'you' ? 'secondary' : 'text'}>{l.text}</Text>
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}

/** Picks where the bot's voice plays (HTMLMediaElement.setSinkId); only engines that play through an audio element can. */
function SpeakerButton({ engine }: { engine: VoiceEngine | null }) {
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [chosen, setChosen] = useState('')
  const [error, setError] = useState<string | null>(null)
  const can = !!engine?.canChooseOutput
  const title = can ? 'Speaker' : 'This voice plays through the system speaker. Kith voice can pick another output.'

  const toggle = async () => {
    if (open) return setOpen(false)
    setError(null)
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(
        all
          .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` })),
      )
    } catch (e) {
      setError(errorMessage(e))
    }
    setOpen(true)
  }

  const pick = async (id: string) => {
    setChosen(id)
    setOpen(false)
    await engine?.setOutputDevice(id)
  }

  return (
    <div className="call-speaker">
      <button className={`call-round big ${chosen ? 'on' : ''}`} title={title} aria-label="Speaker" aria-haspopup="menu" aria-expanded={open} disabled={!can} onClick={() => void toggle()}>
        <Icon name="speaker.wave.2.fill" size={20} weight="medium" scaled={false} />
      </button>
      {open ? (
        <div className="call-speaker-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <button role="menuitemradio" aria-checked={chosen === ''} className="call-speaker-item" onClick={() => void pick('')}>
            <Text size="compactBody">System default</Text>
            {chosen === '' ? <Icon name="checkmark" size={12} weight="semibold" scaled={false} /> : null}
          </button>
          {devices.map((d) => (
            <button key={d.id} role="menuitemradio" aria-checked={chosen === d.id} className="call-speaker-item" onClick={() => void pick(d.id)}>
              <Text size="compactBody" truncate>{d.label}</Text>
              {chosen === d.id ? <Icon name="checkmark" size={12} weight="semibold" scaled={false} /> : null}
            </button>
          ))}
          {error ? <Text as="div" size="caption" tone="danger" className="call-speaker-error">{error}</Text> : null}
        </div>
      ) : null}
    </div>
  )
}
