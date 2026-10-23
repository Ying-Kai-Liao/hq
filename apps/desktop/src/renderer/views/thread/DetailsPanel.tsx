import { isGroup, isWorking, type Bot } from '@shared/models'
import { AgentIcon } from '../../components/AgentIcon'
import { BotAvatar, GroupAvatar } from '../../components/Avatar'
import { Button, IconButton, RowLabel, Switch, TabChoice } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { HStack, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useStore } from '../../store/context'
import type { KithInfoStore } from '../../store/kith-info-store'
import { BotSettingsPanel } from '../bots/BotEditorView'
import { KithDetails, KithHeader } from '../bots/kith/KithDetails'
import { useKithInfo } from '../bots/kith/use-kith'
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
export function DetailsPanel({ botId, routineId, callBlocked, onCall, tab, setTab, editGroup, share, close }: {
  botId: string
  routineId: string | null
  /** Why a call can't start now (offline, no voice); null when it can. */
  callBlocked: string | null
  /** Starts a call in this chat; null while one is running. */
  onCall: (() => void) | null
  tab: DetailsTab
  setTab: (tab: DetailsTab) => void
  editGroup: () => void
  share: () => void
  close: () => void
}) {
  const store = useStore()
  const bot = store.bots.get(botId) ?? null
  const group = !!bot && isGroup(bot)
  const kith = useKithInfo(botId, true)
  return (
    <div className="details-panel">
      <div className="details-drag" />
      <div className="details-actions">
        {bot && !group ? <MacChatButton className="ringed" title="Create template" icon="square.and.arrow.up" onClick={share} /> : null}
        <MacChatButton className="ringed" title="Close details" icon="xmark" onClick={close} />
      </div>
      <div className="details-scroll">
        {bot ? <Identity bot={bot} kith={kith} /> : null}
        {bot ? (
          <div className="details-call">
            <Button kind="secondary" disabled={!onCall || !!callBlocked} title={callBlocked ?? (onCall ? 'Start a voice call' : 'A call is running')} onClick={() => onCall?.()}>
              <Icon name="phone.fill" size={13} weight="medium" /> {onCall ? 'Call' : 'In call'}
            </Button>
          </div>
        ) : null}
        {bot && group ? (
          <GroupMembersList group={bot} editGroup={editGroup} />
        ) : (
          <>
            <TabChoice label="Conversation details" selection={tab} options={TABS} onChange={setTab} />
            <div key={tab} className="details-tab fade-in">
              {tab === 'details' ? (
                <>
                  {kith ? <KithDetails kith={kith} /> : null}
                  <BotSettingsPanel botId={botId} part="often" />
                  {bot ? <ComputerUse bot={bot} /> : null}
                  <RoutinesView botId={botId} initialId={routineId} />
                </>
              ) : tab === 'memory' ? (
                <MemoryCard botId={botId} />
              ) : (
                <BotSettingsPanel botId={botId} part="rarely" />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The bot's avatar and name, and what runs it (a group: how many bots it has). */
function Identity({ bot, kith }: { bot: Bot; kith: KithInfoStore | null }) {
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
      {kith && bot.hqAgent ? <KithHeader agent={bot.hqAgent} kith={kith} /> : null}
    </div>
  )
}

/** Whether this bot may use the computer, switched right here (also in Settings). */
function ComputerUse({ bot }: { bot: Bot }) {
  const store = useStore()
  const screen = store.screen
  if (!screen) return null
  const ready = screen.platform === 'windows' || (screen.enabled && screen.connected && screen.capture && screen.input)
  return (
    <section className="details-section">
      <span className="details-section-title">Computer</span>
      <div className="outlined-card details-switch">
        <RowLabel grow label="Use the computer" detail={ready ? null : 'On that computer, open Kith → Settings → Computer access to set it up first.'} />
        <HStack as="span" align="stretch" className="details-switch-control">
          <Switch label="Use the computer" on={bot.computer} disabled={store.isOffline} onChange={(on) => store.setComputer(bot, on)} />
        </HStack>
      </div>
    </section>
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
            <VStack as="span" gap={1} grow>
              <span className="member-name">{bot.name}</span>
              {isWorking(bot) ? <Text size="compactSecondary" tone="secondary" className="member-name">{bot.activity || 'Working…'}</Text> : null}
            </VStack>
          </button>
          {group.members.length > 1 ? <IconButton title={`Remove ${bot.name} from the group`} icon="xmark" onClick={() => store.removeMember(group, bot.id)} /> : null}
        </div>
      ))}
      <button className="member-row press" onClick={editGroup}>
        <span className="member-add-icon">
          <Icon name="plus" size={16} color="var(--secondary)" />
        </span>
        <Text tone="secondary" className="member-name">Add Member</Text>
      </button>
    </div>
  )
}
