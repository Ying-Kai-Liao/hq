import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { BotAvatar, type BotSize } from './BotAvatar'
import type { CrewFace } from './CrewRow'
import { OriginTag, WriterChip, type Origin } from './Badges'
import { repliesLabel } from './logic.ts'
import { pairStyle, type Pair } from './pair.ts'
import './kith.css'

export type Place = { kind: 'project'; name: string } | { kind: 'folder'; name: string }

export interface ThreadInfo {
  replies: number
  /** Unread replies; "1 new" in the agent's pair. */
  newCount?: number
  /** "8:14", "now". */
  time: string
  open: boolean
  /** The agent that replies: its face on the chip, its pair for the line and the pill. */
  agent: CrewFace
  pair: Pair
  /** A briefcase and the project, or a folder only outside a project. */
  place?: Place
  origin?: Origin
  writer?: { working: boolean }
  /** Your turn: a dot and "your turn" in place of the new pill. */
  yourTurn?: boolean
  /** The chip's arrow folds or opens the replies in place. */
  onToggle: () => void
  /** The chip's text opens the thread full screen. */
  onOpen?: () => void
}

function PlaceText({ place }: { place: Place }) {
  return (
    <span className="kc-place kith-text-secondary">
      <Icon name={place.kind === 'project' ? 'briefcase' : 'folder'} size={11} />
      <span className="kc-place-name">{place.name}</span>
    </span>
  )
}

/** The thread under a user bubble: place and tags in small grey, then the chip (bot 24, replies, new, time, arrow). */
export function ThreadChip({ thread }: { thread: ThreadInfo }) {
  const t = thread
  const label = `${repliesLabel(t.replies)}${t.newCount ? `, ${t.newCount} new` : ''}, ${t.time}`
  return (
    <div className="kc-thread-meta" style={pairStyle(t.pair)}>
      <span className="kc-thread-tags">
        {t.writer ? <WriterChip working={t.writer.working} pair={t.pair} /> : t.origin ? <OriginTag origin={t.origin} /> : null}
        {t.place ? <PlaceText place={t.place} /> : null}
      </span>
      <span className={`kc-thread-chip ${t.open ? 'open' : ''}`}>
        <button className="kc-thread-open" onClick={t.onOpen ?? t.onToggle} aria-label={`View thread, ${label}`}>
          <BotAvatar face={t.agent.face} color={t.agent.color} id={t.agent.id} size={24 as BotSize} animated={false} />
          <span className="kc-thread-replies kith-text-secondary">{repliesLabel(t.replies)}</span>
          {t.yourTurn ? (
            <span className="kc-your-turn kith-text-label">
              <i aria-hidden />
              your turn
            </span>
          ) : t.newCount ? (
            <span className="kc-new kith-text-label">{t.newCount} new</span>
          ) : null}
          <span className="kc-thread-time kith-text-secondary">{t.time}</span>
        </button>
        <button className="kc-thread-arrow" onClick={t.onToggle} aria-expanded={t.open} aria-label={t.open ? 'Fold replies' : 'Open replies'}>
          <Icon name={t.open ? 'chevron.up' : 'chevron.down'} size={10} weight="bold" />
        </button>
      </span>
    </div>
  )
}

/**
 * One turn: your bubble on the right with the thread chip under it, or an agent bubble on the left.
 * Open replies go in `replies` and sit under a thin line in the agent's pair.
 */
export function TranscriptTurn({ role, children, thread, replies }: {
  role: 'user' | 'agent'
  children: ReactNode
  thread?: ThreadInfo
  replies?: ReactNode
}) {
  return (
    <div className={`kc-turn ${role}`}>
      <div className={`kc-bubble ${role} kith-text-body`}>{children}</div>
      {role === 'user' && thread ? <ThreadChip thread={thread} /> : null}
      {role === 'user' && thread?.open && replies ? (
        <div className="kc-thread-replies-open" style={pairStyle(thread.pair)}>
          {replies}
        </div>
      ) : null}
    </div>
  )
}

/** The time separator: 11 semibold muted with a hairline both sides. Also marks a change of writer. */
export function TranscriptDivider({ children, icon }: { children: ReactNode; icon?: string }) {
  return (
    <div className="kc-divider kith-text-label" role="separator">
      <span className="kc-divider-line" />
      <span className="kc-divider-text">
        {icon ? <Icon name={icon} size={10} weight="medium" /> : null}
        {children}
      </span>
      <span className="kc-divider-line" />
    </div>
  )
}
