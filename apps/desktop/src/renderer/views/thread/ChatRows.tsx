import { FileDownloadCard } from './FileDownloadCard'
import { memo, useEffect, useRef, useState } from 'react'
import { isGroup, isWorking, needsInput, type Bot, type Entry, type ThreadSummary } from '@shared/models'
import { BotAvatar } from '../../components/Avatar'
import { Hairline, IconButton } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { AnchoredMenu, useContextMenu, type MenuItem, type ReactionPick } from '../../components/Overlay'
import { HStack, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { ThinkingOrb } from '../../components/ThinkingOrb'
import { avatarColor } from '../../lib/theme'
import { useStore as useLiveStore, useStoreRef as useStore } from '../../store/context'
import { QUICK_REACTIONS, type BotStore } from '../../store/bot-store'
import { AttachmentList } from './Attachments'
import { relativeTime } from './chat-items'
import { MarkdownText } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { ConnectionRequestCard } from '../marketplace/ConnectionRequestCard'
import { HandoffNotice } from './HandoffNotice'

export function reactionPick(store: BotStore, entry: Entry): ReactionPick {
  return { emoji: QUICK_REACTIONS, chosen: entry.data.reactions ?? [], toggle: (e) => store.react(entry, e) }
}

/** One chat-visible entry in a chat or a thread, with what can be done to it. */
export const ChatRow = memo(function ChatRow({ entry, groupStart, chat, openTrace, openThread }: {
  entry: Entry
  groupStart: boolean
  chat: Bot | null
  openTrace: () => void
  /** Main chat only: start (or open) the thread on this message. */
  openThread?: (e: Entry) => void
}) {
  const reply = openThread ? () => openThread(entry) : undefined
  const chip = entry.data.thread && entry.data.thread.count > 0 && openThread ? <ThreadChip summary={entry.data.thread} open={() => openThread(entry)} /> : null
  switch (entry.kind) {
    case 'user':
      return (
        <VStack align="flex-end" gap={4} className={groupStart ? 'chat-row group-start' : 'chat-row'}>
          <UserBubble entry={entry} botWorking={!!chat && isWorking(chat)} reply={reply} />
          <ReactionsRow entry={entry} />
          {chip}
        </VStack>
      )
    case 'agent':
      return (
        <VStack align="flex-start" gap={4} className={groupStart ? 'chat-row group-start' : 'chat-row'}>
          {chat && isGroup(chat) && groupStart ? <AuthorLabel botId={entry.data.author} /> : null}
          <AgentBubble entry={entry} openTrace={openTrace} reply={reply} />
          <VStack gap={4} className={chat && isGroup(chat) ? 'chat-row-indent' : undefined}>
            <ReactionsRow entry={entry} />
            {chip}
          </VStack>
        </VStack>
      )
    case 'permission':
      return (
        <VStack gap={4} className="chat-row group-start">
          {chat && isGroup(chat) ? <AuthorLabel botId={entry.data.author} /> : null}
          <LivePermission entry={entry} />
        </VStack>
      )
    default:
      if (entry.data.connectionRequest) return <div className="chat-row group-start"><ConnectionRequestCard entry={entry} /></div>
      if (entry.data.handoff) return <div className="chat-row notice"><HandoffNotice entry={entry} card={entry.data.handoff} /></div>
      return <div className="chat-row notice"><NoticeRow entry={entry} /></div>
  }
})

/** Follows the store: the card shows a spinner while its answer is on its way. */
function LivePermission({ entry }: { entry: Entry }) {
  const store = useLiveStore()
  return <PermissionCard entry={entry} hostName={store.hostName} answering={store.answering.get(entry.id) ?? null} respond={(o) => store.respond(entry, o)} />
}

/** Who wrote a message in a group: their avatar and name in their color. */
export function AuthorLabel({ botId }: { botId?: string | null }) {
  const store = useStore()
  const bot = botId ? store.bots.get(botId) : undefined
  return (
    <HStack gap={8}>
      {bot ? <BotAvatar bot={bot} size={26} animated={false} /> : null}
      <Text size="subheadline" weight="medium" tone="secondary" style={bot ? { color: avatarColor(bot.avatarColor) } : undefined}>{store.authorName(botId)}</Text>
    </HStack>
  )
}

/** Under a message with a thread (Slack's): who replied, how many, how recently. */
export function ThreadChip({ summary, open }: { summary: ThreadSummary; open: () => void }) {
  const store = useStore()
  const authors = summary.authors.map((id) => store.bots.get(id)).filter((b): b is Bot => !!b).slice(0, 3)
  const unread = summary.unread ?? 0
  return (
    <button
      className="press thread-chip"
      onClick={open}
      title="View thread"
      aria-label={`View thread, ${summary.count} ${summary.count === 1 ? 'reply' : 'replies'}${unread > 0 ? `, ${unread} new` : ''}`}
    >
      {authors.length ? (
        <HStack as="span" align="stretch" className="thread-chip-authors">
          {authors.map((b) => (
            <span key={b.id}>
              <BotAvatar bot={b} size={18} animated={false} />
            </span>
          ))}
        </HStack>
      ) : null}
      <Text size="footnote" weight="semibold" tone="accent">{summary.count === 1 ? '1 reply' : `${summary.count} replies`}</Text>
      {unread > 0 ? (
        <Text size="footnote" weight="semibold" tone="text">{unread} new</Text>
      ) : (
        <Text size="footnote" tone="tertiary">{relativeTime.day(summary.lastAt)}</Text>
      )}
      <Icon name="chevron.right" size={10} color="var(--tertiary)" />
    </button>
  )
}

/** A message's text with a right-click menu (with quick reactions on top). */
export function Bubble({ className, items, reactions, children }: { className: string; items: () => MenuItem[]; reactions?: ReactionPick; children: React.ReactNode }) {
  const menu = useContextMenu()
  return (
    <>
      <div className={className} onContextMenu={menu.onContextMenu}>
        {children}
      </div>
      <AnchoredMenu open={menu.open} onClose={menu.close} point={menu.point} items={items} reactions={reactions} />
    </>
  )
}

/** The centered time label between runs of messages. */
export function TimeSeparator({ date }: { date: number }) {
  return <Text as="div" size="footnote" tone="tertiary" className="time-separator">{relativeTime.separator(date)}</Text>
}

const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function UserBubble({ entry, botWorking, reply }: { entry: Entry; botWorking: boolean; reply?: () => void }) {
  const store = useStore()
  const [hovering, setHovering] = useState(false)
  const status = entry.data.status
  const copy = () => entry.data.text && window.codync.app.copy(entry.data.text)
  return (
    <div className="message user" title={fullDate.format(entry.createdAt)} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <div className="message-body">
        {entry.data.attachments?.length ? <AttachmentList attachments={entry.data.attachments} botId={entry.botId} /> : null}
        {entry.data.text ? (
          <Bubble
            className="bubble user selectable"
            reactions={reactionPick(store, entry)}
            items={() => [
              { title: 'Copy', icon: 'square.on.square', action: copy },
              ...(reply ? [{ title: 'Reply in thread', icon: 'arrowshape.turn.up.left', action: reply }] : []),
            ]}
          >
            {entry.data.text}
          </Bubble>
        ) : null}
        {status && status !== 'sent' ? <UserStatus entry={entry} botWorking={botWorking} hovering={hovering} /> : null}
        {/* Beside the bubble, inside its hover region: showing them never changes the height. */}
        <MessageActions className="leading" visible={hovering} reactions={reactionPick(store, entry)} reply={reply} copy={copy} />
      </div>
    </div>
  )
}

function UserStatus({ entry, botWorking, hovering }: { entry: Entry; botWorking: boolean; hovering: boolean }) {
  const store = useStore()
  switch (entry.data.status) {
    case 'sending':
      return <Text size="caption2" tone="tertiary">Sending…</Text>
    case 'queued':
      return <Text size="caption2" tone="tertiary">{botWorking ? 'Queued until this response finishes' : 'Queued'}</Text>
    case 'failed':
      return (
        <HStack as="span" gap={2}>
          <Text size="caption2" weight="semibold" tone="danger" className="user-status-error">Failed to send</Text>
          <IconButton title="Resend" icon="arrow.clockwise" size={24} onClick={() => store.retry(entry)} />
          <IconButton title="Delete" icon="trash" size={24} onClick={() => store.discard(entry)} />
        </HStack>
      )
    case 'cancelled':
      return <Text size="caption2" tone="tertiary">Not sent — stopped</Text>
    default:
      return <Text size="caption" tone="tertiary" className={hovering ? 'user-status-time shown' : 'user-status-time'}>{relativeTime.time(entry.createdAt)}</Text>
  }
}

export function AgentBubble({ entry, openTrace, reply }: { entry: Entry; openTrace: () => void; reply?: () => void }) {
  const store = useStore()
  const [hovering, setHovering] = useState(false)
  const copy = () => entry.data.text && window.codync.app.copy(entry.data.text)
  return (
    <div className="message agent" title={fullDate.format(entry.createdAt)} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <div className="message-body">
        <Bubble
          className={entry.data.files?.length ? "file-message" : "bubble agent"}
          reactions={reactionPick(store, entry)}
          items={() => [
            { title: 'Copy', icon: 'square.on.square', action: copy },
            ...(reply ? [{ title: 'Reply in thread', icon: 'arrowshape.turn.up.left', action: reply }] : []),
            { title: 'Show what it did', icon: 'list.bullet', action: openTrace },
          ]}
        >
          {entry.data.files?.length ? <div className="file-message-cards">{entry.data.files.map((file) => <FileDownloadCard key={file.id} entry={entry} file={file} />)}</div> : <MarkdownText text={entry.data.text ?? ''} />}
        </Bubble>
        <MessageActions className="trailing" visible={hovering} reactions={reactionPick(store, entry)} reply={reply} trace={openTrace} copy={copy} />
      </div>
    </div>
  )
}

export function NoticeRow({ entry }: { entry: Entry }) {
  const text = entry.data.text ?? ''
  if (entry.data.callSeconds !== undefined) {
    const s = entry.data.callSeconds
    return (
      <HStack justify="center" gap={6}>
        <Icon name="waveform" size={10} color="var(--secondary)" />
        <Text size="footnote" tone="secondary" tabular>{`${text} · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`}</Text>
      </HStack>
    )
  }
  switch (entry.data.style) {
    case 'divider':
      return (
        <HStack gap={10} className="chat-notice-divider">
          <Hairline grow />
          <Text size="caption2" tone="tertiary" className="chat-notice-divider-text">{text}</Text>
          <Hairline grow />
        </HStack>
      )
    case 'error':
      return (
        <HStack align="flex-start" gap={8} className="chat-notice-error">
          <Icon name="exclamationmark.triangle.fill" size={10} color="var(--danger)" />
          <Text size="footnote" tone="text" className="selectable">{text}</Text>
        </HStack>
      )
    default:
      return <Text as="div" size="footnote" tone="secondary" className="chat-notice">{text}</Text>
  }
}

/**
 * The bot's live activity line: a turning orb, what it's doing and for how long. Clicking it
 * unfolds what the bot is thinking right now.
 */
export function WorkingIndicator({ bot, thinking }: { bot: Bot; thinking: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const waiting = needsInput(bot)
  return (
    <HStack gap={10} className="agent-inset">
      <button className="working" disabled={!thinking} onClick={() => setExpanded((e) => !e)} aria-expanded={thinking ? expanded : undefined}>
        <HStack as="span" gap={8}>
          <ThinkingOrb state={waiting ? 'listening' : 'working'} size={16} color={waiting ? 'var(--warning)' : 'var(--secondary)'} />
          <Text size="subheadline" tone={waiting ? 'attention' : 'secondary'} truncate>{bot.activity || 'Working…'}</Text>
          {bot.startedAt ? <Timer since={bot.startedAt} /> : null}
          {thinking ? (
            <HStack as="span" align="stretch" className={expanded ? 'working-chevron expanded' : 'working-chevron'}>
              <Icon name="chevron.down" size={10} weight="semibold" color="var(--tertiary)" />
            </HStack>
          ) : null}
        </HStack>
        {expanded && thinking ? (
          <div className="selectable thinking" ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight
          }}>
            {thinking}
          </div>
        ) : null}
      </button>
    </HStack>
  )
}

/** `Text(date, style: .timer)`: 0:42, 12:05, 1:02:33. */
function Timer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return <Text size="footnote" tone="tertiary" tabular>{h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`}</Text>
}

/** The user's reactions under a message; clicking one takes it back. */
export function ReactionsRow({ entry }: { entry: Entry }) {
  const store = useStore()
  const reactions = entry.data.reactions
  if (!reactions?.length) return null
  return (
    <HStack align="stretch" gap={4}>
      {reactions.map((emoji) => (
        <button key={emoji} className="press reaction-chip" title={`Remove ${emoji}`} aria-label={`Remove reaction ${emoji}`} onClick={() => store.react(entry, emoji)}>
          <Text size="body">{emoji}</Text>
        </button>
      ))}
    </HStack>
  )
}

/** Compact actions beside the bubble: a reaction strip, reply in thread, and more (copy, what it did). */
function MessageActions({ visible, className, reactions, reply, trace, copy }: {
  visible: boolean
  className: string
  reactions: ReactionPick
  reply?: () => void
  trace?: () => void
  copy: () => void
}) {
  const [menu, setMenu] = useState<'reactions' | 'more' | null>(null)
  const smile = useRef<HTMLButtonElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const shown = visible || menu !== null
  return (
    <div className={`message-actions ${className} ${shown ? 'shown' : ''}`} aria-hidden={!shown}>
      <button ref={smile} className="message-action" title="Add reaction" aria-label="Add reaction" onClick={() => setMenu('reactions')}>
        <Icon name="face.smiling" size={14} />
      </button>
      {reply ? <IconButton title="Reply in thread" icon="arrowshape.turn.up.left" size={26} onClick={reply} /> : null}
      <button ref={more} className="message-action" title="More message actions" aria-label="More message actions" onClick={() => setMenu('more')}>
        <Icon name="ellipsis" size={14} />
      </button>
      <AnchoredMenu open={menu === 'reactions'} onClose={() => setMenu(null)} anchor={smile} items={() => []} reactions={reactions} />
      <AnchoredMenu
        open={menu === 'more'}
        onClose={() => setMenu(null)}
        anchor={more}
        items={() => [{ title: 'Copy', icon: 'square.on.square', action: copy }, ...(trace ? [{ title: 'Show what it did', icon: 'list.bullet', action: trace }] : [])]}
      />
    </div>
  )
}
