import type { Face } from '../Avatar'
import { LiveBot } from '../Avatar'
import { BotAvatar, SkyPatch, type BotState } from './BotAvatar'
import { CountBadge } from './Badges'
import './kith.css'

export interface CrewFace {
  face: Face
  color?: string
  id: string
}

interface Common {
  /** The row's name; one line with an ellipsis. */
  name: string
  /** Right side: a time ("9:02", "Yesterday") or a state ("working", "asleep · 2 h"). */
  right?: string
  /** One-line status or last message. */
  status?: string
  /** Questions waiting on you. */
  count?: number
  selected?: boolean
  onClick?: () => void
}

export type CrewRowProps = Common &
  (
    | { shape: 'agent'; bot: CrewFace; state?: BotState }
    /** A shared room with a default agent: the agent's face, a teammate's sky patch lower-left. */
    | { shape: 'team'; bot: CrewFace; state?: BotState; mateId: string; mateName?: string }
    /** Several agents and people: two bots on the diagonal plus a sky patch; the name is Inter, never Nunito. */
    | { shape: 'group'; bots: [CrewFace, CrewFace]; personId: string; state?: BotState }
  )

function Face48(props: CrewRowProps) {
  const state = props.state ?? 'idle'
  if (props.shape === 'group') {
    const [a, b] = props.bots
    return (
      <span className="kc-face kc-face-group" aria-hidden>
        <span className="kc-bot-shadow kc-g1">
          <LiveBot face={a.face} color={a.color} size={30} id={a.id} animated={false} mood="idle" />
        </span>
        <span className="kc-bot-shadow kc-g2">
          <LiveBot face={b.face} color={b.color} size={30} id={b.id} animated={false} mood="idle" />
        </span>
        <span className="kc-g3">
          <SkyPatch id={props.personId} size={18} />
        </span>
      </span>
    )
  }
  return (
    <span className="kc-face">
      <BotAvatar face={props.bot.face} color={props.bot.color} id={props.bot.id} size={48} state={state === 'needsYou' ? 'idle' : state} />
      {props.shape === 'team' ? (
        <span className="kc-mate">
          <SkyPatch id={props.mateId} size={20} />
        </span>
      ) : null}
    </span>
  )
}

/** One room in Crew (and the Mac sidebar): face, name, state or time, one status line, the ink count. */
export function CrewRow(props: CrewRowProps) {
  const { name, right, status, count = 0, selected = false, onClick } = props
  const group = props.shape === 'group'
  const label = [name, props.shape === 'team' && props.mateName ? `with ${props.mateName}` : '', right, status, count > 0 ? `${count} waiting` : ''].filter(Boolean).join(', ')
  return (
    <button className={`kc-crew-row ${selected ? 'selected' : ''}`} onClick={onClick} aria-pressed={selected} aria-label={label}>
      <Face48 {...props} />
      <span className="kc-crew-main">
        <span className="kc-crew-top">
          <span className={`kc-crew-name ${group ? 'kith-text-top-bar' : 'kith-text-agent-name'}`}>{name}</span>
          {props.shape === 'team' && props.mateName ? <span className="kc-crew-with kith-text-secondary">with {props.mateName}</span> : null}
          {right ? <span className="kc-crew-right kith-text-secondary">{right}</span> : null}
        </span>
        <span className="kc-crew-bottom">
          <span className="kc-crew-status kith-text-body">{status}</span>
          {count > 0 ? <CountBadge count={count} /> : null}
        </span>
      </span>
    </button>
  )
}
