import { isGroup, isWorking, type Bot } from '@shared/models'
import { AgentIcon } from '../../components/AgentIcon'
import { BotAvatar, GroupAvatar } from '../../components/Avatar'
import { CardSection, IconButton, TabChoice, ValueRow } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { BotSettingsPanel } from '../bots/BotEditorView'
import { MemoryCard } from '../bots/MemoryView'
import { RoutinesView } from '../routines/RoutinesView'
import { MacChatButton } from './MacChatButton'
import '../bots/bots.css'
import './details-panel.css'

export type DetailsTab = 'details' | 'memory' | 'settings'

const TABS: { id: DetailsTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
]

/** The inspector beside a conversation (Grok Bot's): who the bot is, then its details, memory and settings. */
export function DetailsPanel({ botId, routineId, tab, setTab, editGroup, share, close }: {
  botId: string
  routineId: string | null
  tab: DetailsTab
  setTab: (tab: DetailsTab) => void
  editGroup: () => void
  share: () => void
  close: () => void
}) {
  const store = useStore()
  const bot = store.bots.get(botId) ?? null
  const group = !!bot && isGroup(bot)
  return (
    <div className="details-panel">
      <div className="details-actions">
        {bot && !group ? <MacChatButton className="ringed" title="Create template" icon="square.and.arrow.up" onClick={share} /> : null}
        <MacChatButton className="ringed" title="Close details" icon="xmark" onClick={close} />
      </div>
      <div className="details-scroll">
        {bot ? <Identity bot={bot} /> : null}
        {bot && group ? (
          <GroupMembersList group={bot} editGroup={editGroup} />
        ) : (
          <>
            <TabChoice label="Conversation details" selection={tab} options={TABS} onChange={setTab} />
            <div key={tab} className="details-tab fade-in">
              {tab === 'details' ? (
                <>
                  {bot ? <ComputerUse bot={bot} /> : null}
                  <RoutinesView botId={botId} initialId={routineId} />
                </>
              ) : tab === 'memory' ? (
                <MemoryCard botId={botId} />
              ) : (
                <BotSettingsPanel botId={botId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The bot's avatar and name, and what runs it (a group: how many bots it has). */
function Identity({ bot }: { bot: Bot }) {
  const store = useStore()
  const group = isGroup(bot)
  return (
    <div className="details-identity">
      {group ? <GroupAvatar members={store.members(bot)} size={60} /> : <BotAvatar bot={bot} size={60} />}
      <span className="details-name">{bot.name}</span>
      <span className="details-subtitle">
        {group ? (
          `${bot.members.length} ${bot.members.length === 1 ? 'bot' : 'bots'}`
        ) : (
          <>
            <AgentIcon registry={store.hello?.backends.find((b) => b.id === bot.backend)?.registry ?? bot.backend} size={12} />
            {store.backendName(bot.backend)}
            {bot.model ? ` · ${bot.model}` : null}
          </>
        )}
      </span>
    </div>
  )
}

/** Whether this bot may use the computer; it's changed in Settings. */
function ComputerUse({ bot }: { bot: Bot }) {
  const store = useStore()
  if (!store.screen) return null
  return (
    <CardSection title="Computer">
      <ValueRow label="Use the computer">{bot.computer ? 'On' : 'Off'}</ValueRow>
    </CardSection>
  )
}

/** A group's bots (Grok Bot's member list); clicking one opens its own chat. */
function GroupMembersList({ group, editGroup }: { group: Bot; editGroup: () => void }) {
  const store = useStore()
  return (
    <div className="details-members">
      {store.members(group).map((bot) => (
        <div key={bot.id} className="member-row removable">
          <button className="member-open press" title={`Open ${bot.name}'s own chat`} onClick={() => store.setSelection(bot.id)}>
            <BotAvatar bot={bot} size={32} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
              <span className="member-name">{bot.name}</span>
              {isWorking(bot) ? <span className="member-name" style={{ ...font('compactSecondary'), color: 'var(--secondary)' }}>{bot.activity || 'Working…'}</span> : null}
            </span>
          </button>
          {group.members.length > 1 ? <IconButton title={`Remove ${bot.name} from the group`} icon="xmark" onClick={() => store.removeMember(group, bot.id)} /> : null}
        </div>
      ))}
      <button className="member-row press" onClick={editGroup}>
        <span style={{ width: 32, display: 'grid', placeItems: 'center' }}>
          <Icon name="plus" size={16} color="var(--secondary)" />
        </span>
        <span className="member-name" style={{ color: 'var(--secondary)' }}>Add Member</span>
      </button>
    </div>
  )
}
