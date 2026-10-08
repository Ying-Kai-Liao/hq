import { memo } from 'react'
import { folderName, isGroup, isWorking, needsInput, type Bot } from '@shared/models'
import { AvatarWithStatus } from '../components/Avatar'
import { Icon } from '../components/Icon'
import { ThinkingOrb } from '../components/ThinkingOrb'
import { font } from '../lib/fonts'
import { messagePreview } from '../lib/message-preview'
import type { BotStore } from '../store/bot-store'

/** A roster row: avatar with status, name, and the live activity or last message (Grok Bot's desktop sidebar). */
export const BotRow = memo(function BotRow({ bot, store, compact, usingComputer, members }: { bot: Bot; store: BotStore; compact: boolean; usingComputer: boolean; members: Bot[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 0 : 10, padding: '9px 0', width: '100%', justifyContent: compact ? 'center' : 'flex-start' }}>
      <AvatarWithStatus bot={bot} members={members} size={30} />
      <div
        aria-hidden={compact}
        style={{
          display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 'calc(16px * var(--scale))', minWidth: 0, overflow: 'hidden',
          width: compact ? 0 : undefined, flex: compact ? 'none' : 1, opacity: compact ? 0 : 1,
          transition: 'opacity var(--layout)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
          {bot.pinned ? <Icon name="pin.fill" size={10} color="var(--tertiary)" /> : null}
          <span style={{ ...font('body', bot.unread > 0 ? 'semibold' : 'medium'), color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bot.name}</span>
          {usingComputer ? <Icon name="cursorarrow.motionlines" size={10} color="var(--accent)" title="Using the computer" /> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
            <Preview bot={bot} store={store} />
          </div>
          {bot.unread > 0 ? (
            <span
              style={{
                ...font('caption2', 'semibold'), color: 'var(--on-accent)', background: 'var(--accent-fill)', borderRadius: 999,
                padding: '0 6px', minWidth: 18, height: 18, display: 'grid', placeItems: 'center', flex: 'none',
              }}
            >
              {bot.unread}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
})

const line: React.CSSProperties = { ...font('callout'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }

/** Live activity while working, otherwise the last message (Grok Bot row behavior). */
function Preview({ bot, store }: { bot: Bot; store: BotStore }) {
  if (needsInput(bot)) {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warning)', minWidth: 0 }}>
        <ThinkingOrb state="listening" size={16} color="var(--warning)" />
        <span style={line}>{bot.activity || 'Needs your approval'}</span>
      </span>
    )
  }
  if (isWorking(bot)) {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--secondary)', minWidth: 0 }}>
        <ThinkingOrb size={13} color="var(--secondary)" />
        <span style={line}>{bot.activity || 'Working…'}</span>
      </span>
    )
  }
  if (bot.status === 'error') return <span style={{ ...line, color: 'var(--danger)' }}>{messagePreview(bot.lastMessage ?? 'Something went wrong')}</span>
  return <span style={{ ...line, color: 'var(--secondary)' }}>{messagePreview(bot.lastMessage ?? (isGroup(bot) ? `${bot.members.length} bots` : `${store.backendName(bot.backend)} · ${folderName(bot)}`))}</span>
}
