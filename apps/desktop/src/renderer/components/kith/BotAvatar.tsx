import type { CSSProperties } from 'react'
import { LiveBot, type Face } from '../Avatar'
import { CountBadge } from './Badges'
import { skyPatchOf } from './logic.ts'
import './kith.css'

export type BotState = 'working' | 'needsYou' | 'idle' | 'asleep'
export type BotSize = 48 | 30 | 24 | 84

/**
 * A bot with no tile and a soft shadow, around the living bot (Avatar.tsx's LiveBot, untouched).
 * working: hop dots lower-right; needsYou: the count badge upper-right; asleep: faded and still.
 * A colour without the `kith:` prefix keeps the original body, as LiveBot does.
 */
export function BotAvatar({ face, color = '', id, size = 48, state = 'idle', count = 0, animated = true }: {
  face: Face
  /** An avatarColor, `kith:<palette id>` or empty. */
  color?: string
  /** The bot's id: its loops and phase, the same on every screen. */
  id: string
  size?: BotSize
  state?: BotState
  /** Questions waiting on you; shown with state needsYou. */
  count?: number
  animated?: boolean
}) {
  const mood = state === 'working' ? 'working' : state === 'needsYou' ? 'needsInput' : 'idle'
  return (
    <span className={`kc-bot ${state === 'asleep' ? 'asleep' : ''}`} style={{ width: size, height: size }} data-state={state}>
      <span className="kc-bot-shadow">
        <LiveBot face={face} color={color} mood={mood} size={size} id={id} animated={animated && state !== 'asleep'} />
      </span>
      {state === 'working' ? (
        <span className="kc-hop" style={{ '--hop': `${Math.max(3, Math.round(size / 12))}px` } as CSSProperties} aria-hidden>
          <i />
          <i />
          <i />
        </span>
      ) : null}
      {state === 'needsYou' && count > 0 ? (
        <span className="kc-bot-count">
          <CountBadge count={count} size={size >= 48 ? 18 : 16} />
        </span>
      ) : null}
    </span>
  )
}

/** The default profile picture for a person: a piece of sky, seeded by the account id (you = dawn). No letter. */
export function SkyPatch({ id, you = false, size = 48 }: { id: string; you?: boolean; size?: number }) {
  const p = skyPatchOf(id, you)
  return <span className={`kc-sky kc-sky-${p.tone}`} style={{ width: size, height: size, '--sky-x': `${p.x}%`, '--sky-y': `${p.y}%` } as CSSProperties} aria-hidden />
}
