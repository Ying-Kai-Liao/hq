import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WindowCommand } from '@shared/ipc'
import { draftOf, isGroup, type Bot, type BotDraft } from '@shared/models'
import { CharacterAvatar } from '../components/Avatar'
import { Button, ChoicePicker, IconButton } from '../components/Controls'
import { Icon } from '../components/Icon'
import { AnchoredMenu, Dialog, Sheet, type MenuItem } from '../components/Overlay'
import { font } from '../lib/fonts'
import { useModels } from '../lib/observable'
import { prefs, stepTextSize, usePref, DEFAULT_TEXT_SIZE } from '../lib/prefs'
import { useApp, StoreContext } from '../store/context'
import { refKey, sameRef, parseRef, type BotRef } from '../store/app-model'
import type { BotStore } from '../store/bot-store'
import { BotRow } from './BotRow'
import { ComputerFilterHeader, computerSelection } from './ComputerFilterHeader'
import { ThreadView } from './thread/ThreadView'
import { NewChatView } from './bots/NewChatView'
import { BotEditorView } from './bots/BotEditorView'
import { MarketplaceView } from './marketplace/MarketplaceView'
import { SettingsView, type SettingsPage } from './settings/SettingsView'
import { ApprovalSheet } from './settings/ApprovalSheet'
import { UpdateNeededCard } from './UpdateNeededCard'
import { AccountWelcomeView } from './AccountWelcomeView'
import { useTraySummary } from './tray-summary'
import { useSSHAttachments } from './settings/ssh-model'
import './chat-window.css'

const isMac = window.codync.platform === 'darwin'

/** Native desktop chat: roster on the left, the conversation on the right (Grok Bot's desktop layout). */
export function ChatWindow() {
  const app = useApp()
  const [onboarded, setOnboarded] = usePref(prefs.onboardingDone)
  const [confirmReset, setConfirmReset] = useState(false)
  useTraySummary(app)
  useSSHAttachments(app)
  const showsChat = app.host.state.kind === 'running' || app.computers.length > 0

  useEffect(
    () =>
      window.codync.app.onCommand((c: WindowCommand) => {
        switch (c.kind) {
          case 'confirmReset':
            return setConfirmReset(true)
          case 'reviewApprovals':
            return app.reviewApprovals()
          case 'setTextSize':
            return prefs.textSize.set(c.size)
          case 'stepTextSize':
            return prefs.textSize.set(c.up === null ? DEFAULT_TEXT_SIZE : stepTextSize(prefs.textSize.get(), c.up))
          case 'setUsageIconStyle':
            return prefs.usageIconStyle.set(c.style)
          case 'openBot': {
            const ref = parseRef(c.ref)
            if (ref) app.select(ref)
            return
          }
          case 'stopBot': {
            const ref = parseRef(c.ref)
            if (ref) app.store(ref.computerId)?.stop(ref.botId)
            return
          }
          case 'setRemoteScreen':
            void app.setRemoteScreen(c.on)
            return
        }
      }),
    [app],
  )

  const approval = app.currentApproval
  return (
    <div className="chat-window">
      {onboarded ? (
        showsChat ? (
          <ChatSplitView />
        ) : (
          <HostStateView />
        )
      ) : (
        <AccountWelcomeView onContinue={() => setOnboarded(true)} />
      )}
      <Dialog
        open={confirmReset}
        title="Reset all data?"
        message="Signs out every account and deletes this computer's bots, conversations, keys and settings. Codync then starts over from the welcome screen."
        actions={[{ title: 'Reset everything', destructive: true, action: () => void window.codync.app.resetAllData() }]}
        onClose={() => setConfirmReset(false)}
      />
      {/* Approving a device: the code the device shows must match (spec §4.2 B). Closing puts it off. */}
      <Sheet open={approval !== null} onClose={() => approval && app.deferApproval(approval)}>
        {approval ? <ApprovalSheet key={approval.id} approval={approval} /> : null}
      </Sheet>
    </div>
  )
}

/** What stands between this computer and the chat, with the one action that fixes it. */
function HostStateView() {
  const app = useApp()
  const state = app.host.state
  switch (state.kind) {
    case 'notInstalled':
      return <EmptyState icon="desktopcomputer" title={`Set up this ${isMac ? 'Mac' : 'computer'}`} message={`Codync runs your coding agents through the host, a small background service on this ${isMac ? 'Mac' : 'computer'}.`} action={['Install host', () => window.codync.host.install()]} />
    case 'missingBinary':
      return <EmptyState icon="desktopcomputer.trianglebadge.exclamationmark" title="The host is missing" message="This copy of Codync doesn't include codync-host. Download Codync again from codync.dev or GitHub." />
    case 'failed':
      return <EmptyState icon="desktopcomputer.trianglebadge.exclamationmark" title="The host isn't running" message={state.message} action={['Try again', () => window.codync.host.restart()]} />
    default:
      return <EmptyState icon="desktopcomputer" title="Starting the host…" message="This takes a few seconds." />
  }
}

/** A quiet placeholder for an empty screen: icon, title, a line of help and an optional action. */
export function EmptyState({ icon, title, message, action }: { icon: string; title: string; message: string; action?: [string, () => void] }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={36} weight="light" color="var(--tertiary)" />
      <div style={{ ...font('title3', 'semibold'), color: 'var(--text)' }}>{title}</div>
      <div style={{ ...font('callout'), color: 'var(--secondary)', textAlign: 'center', maxWidth: 360 }}>{message}</div>
      {action ? (
        <Button onClick={action[1]} style={{ marginTop: 4 }}>
          {action[0]}
        </Button>
      ) : null}
    </div>
  )
}

interface BotTarget {
  bot: Bot
  store: BotStore
}

interface EditTarget {
  id: string
  draft: BotDraft
  store: BotStore
}

function ChatSplitView() {
  const app = useApp()
  const [compact, setCompact] = usePref(prefs.sidebarCompact)
  const [sidebarWidth, setSidebarWidth] = usePref(prefs.sidebarWidth)
  const [hidden, setHidden] = usePref(prefs.hiddenComputers)
  const [search, setSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const [composingGroup, setComposingGroup] = useState(false)
  const [composeComputer, setComposeComputer] = useState<string | null>(null)
  const previousSelection = useRef<BotRef | null>(null)
  const [newMenu, setNewMenu] = useState(false)
  const [railNewMenu, setRailNewMenu] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [contextBot, setContextBot] = useState<{ target: BotTarget; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BotTarget | null>(null)
  const [newSessionBot, setNewSessionBot] = useState<BotTarget | null>(null)
  const [marketplace, setMarketplace] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsPage | null>(null)
  const [showAccount, setShowAccount] = useState(false)
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const searchRef = useRef<HTMLInputElement>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const railNewButton = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useModels([...app.stores.values()])

  useEffect(() => {
    const onResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight })
      setSidebarWidth(Math.min(prefs.sidebarWidth.get(), Math.max(260, window.innerWidth - 420)))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setSidebarWidth])

  const sheetHeight = Math.max(420, windowSize.height - 76)
  const stores = app.computers.map((c) => app.store(c.id)).filter((s): s is BotStore => !!s)
  const shown = new Set(computerSelection(app.computers.map((c) => c.id), hidden).shown)
  const onlineStores = stores.filter((s) => shown.has(s.computer.id) && s.connection.kind === 'online' && !s.mismatch)
  const selectedStore = app.selectedStore
  const composeStore = composeComputer ? app.store(composeComputer) : null
  const query = search.trim().toLowerCase()
  const visibleRoster = app.roster.filter(
    (item) =>
      shown.has(item.ref.computerId) &&
      (compact || !query || item.bot.name.toLowerCase().includes(query) || (item.bot.lastMessage ?? '').toLowerCase().includes(query)),
  )

  const compose = (group = false) => {
    setComposingGroup(group)
    // The selected bot's computer if it's online, else this computer, else any online one.
    const target = [selectedStore, app.local].find((s) => s && onlineStores.includes(s)) ?? onlineStores[0]
    if (!target) return
    if (!composing) previousSelection.current = app.selection
    setComposeComputer(target.computer.id)
    app.select(null)
    setComposing(true)
  }

  useEffect(() => {
    if (app.selection) setComposing(false)
  }, [app.selection])

  useEffect(
    () =>
      window.codync.app.onCommand((c) => {
        if (c.kind === 'newChat' && onlineStores.length) compose()
        if (c.kind === 'search') {
          setCompact(false)
          setTimeout(() => searchRef.current?.focus(), 0)
        }
        if (c.kind === 'toggleSidebar') setCompact(!prefs.sidebarCompact.get())
      }),
  )

  // Screenshot/UI checks (development builds): open a screen at launch.
  const debugOpened = useRef(false)
  useEffect(() => {
    const target = window.codync.debugOpen
    if (!target || debugOpened.current) return
    if (target === 'compose' || target === 'group') {
      if (!onlineStores.length) return
      debugOpened.current = true
      compose(target === 'group')
    } else if (target === 'plugins') {
      if (!app.local) return
      debugOpened.current = true
      setMarketplace(app.local.computer.id)
    } else if (target === 'computers') {
      debugOpened.current = true
      setSettings('computers')
    } else {
      const item = app.roster.find((i) => i.bot.name === target)
      if (!item) return
      debugOpened.current = true
      app.select(item.ref)
    }
  })

  const newItems = (): MenuItem[] => [
    { title: 'New chat', icon: 'square.and.pencil', action: () => compose() },
    { title: 'New group chat', icon: 'person.2', action: () => compose(true) },
  ]

  const openMarketplace = () => setMarketplace((selectedStore ?? app.local ?? onlineStores[0])?.computer.id ?? null)

  const botActions = (bot: Bot, store: BotStore): MenuItem[] => [
    { title: bot.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: () => store.setPinned(bot, !bot.pinned) },
    { title: 'Mark as Read', icon: 'bell.badge', action: () => store.markAllRead(bot.id) },
    { title: 'Edit Profile…', icon: 'square.and.pencil', divider: true, action: () => setEditing({ id: crypto.randomUUID(), draft: draftOf(bot), store }) },
    { title: 'Copy conversation ID', icon: 'square.on.square', divider: true, action: () => window.codync.app.copy(bot.id) },
    { title: 'New session', icon: 'arrow.counterclockwise', action: () => setNewSessionBot({ bot, store }) },
    { title: 'Hide from sidebar', icon: 'eye.slash', divider: true, action: () => store.setHidden(bot, true) },
    { title: 'Delete', icon: 'trash', destructive: true, action: () => setConfirmDelete({ bot, store }) },
  ]

  // ↑/↓ in the roster move the selection.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const refs = visibleRoster.map((i) => i.ref)
    if (!refs.length) return
    e.preventDefault()
    const current = refs.findIndex((r) => sameRef(r, app.selection))
    const next = e.key === 'ArrowDown' ? Math.min(current + 1, refs.length - 1) : Math.max(current - 1, 0)
    app.select(refs[next]!)
  }

  // The sidebar's edge drags its width; narrower than 180 collapses it to the rail.
  const dragStart = useRef<{ x: number; width: number } | null>(null)
  const onDividerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragStart.current = { x: e.clientX, width: compact ? 76 : sidebarWidth }
  }
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return
    const proposed = dragStart.current.width + e.clientX - dragStart.current.x
    const nextCompact = proposed < 180
    if (nextCompact !== compact) setCompact(nextCompact)
    if (!nextCompact) setSidebarWidth(Math.min(Math.max(260, proposed), Math.min(420, window.innerWidth - 420)))
  }

  const errorMessage = app.errorMessage
  const mismatchStores = stores.filter((s) => shown.has(s.computer.id) && s.mismatch)
  const selected = app.selection
  const selectedBot = selected && selectedStore?.bots.get(selected.botId)

  let detail: ReactNode
  if (composing && composeStore) {
    detail = (
      <div className="detail-column" key={`${composeStore.computer.id}-${composingGroup}`}>
        {onlineStores.length > 1 ? (
          <ComputerPicker stores={onlineStores} value={composeStore.computer.id} onChange={setComposeComputer} />
        ) : null}
        <StoreContext.Provider value={composeStore}>
          <NewChatView
            group={composingGroup}
            onClose={() => {
              setComposing(false)
              if (!app.selection) app.select(previousSelection.current)
            }}
          />
        </StoreContext.Provider>
      </div>
    )
  } else if (selected && selectedStore && selectedBot) {
    detail = (
      <StoreContext.Provider value={selectedStore}>
        <ThreadView key={refKey(selected)} botId={selected.botId} />
      </StoreContext.Provider>
    )
  } else {
    detail = (
      <div className="empty-detail">
        <div style={{ display: 'flex' }}>
          <CharacterAvatar shape="blob" color="blue" size={60} mood="working" />
          <CharacterAvatar shape="squircle" color="orange" size={60} style={{ marginLeft: -10 }} />
          <CharacterAvatar shape="teardrop" color="violet" size={60} mood="working" style={{ marginLeft: -10 }} />
        </div>
        <div style={font('title2', 'semibold')}>Your coding agents, as teammates.</div>
        <div style={{ color: 'var(--secondary)', textAlign: 'center', maxWidth: 420 }}>Pick a bot, or create one for each kind of work and point it at a project.</div>
        <Button onClick={() => compose()} disabled={!onlineStores.length}>
          New Bot
        </Button>
      </div>
    )
  }

  const width = compact ? 76 : sidebarWidth
  return (
    <div className="split" style={{ pointerEvents: showAccount || contextBot ? 'none' : undefined }}>
      <aside className={`sidebar ${compact ? 'compact' : ''}`} style={{ width }}>
        <div className="sidebar-header drag" style={{ paddingLeft: compact ? 0 : isMac ? 80 : 18, opacity: compact ? 0 : 1, pointerEvents: compact ? 'none' : undefined }} aria-hidden={compact}>
          <span style={{ flex: 1 }} />
          <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ComputerFilterHeader hidden={hidden} setHidden={setHidden} manage={() => setSettings('computers')} />
            <IconButton title="New" icon="plus" buttonRef={newButton} onClick={() => setNewMenu((o) => !o)} disabled={!onlineStores.length} />
          </div>
          <AnchoredMenu open={newMenu} onClose={() => setNewMenu(false)} anchor={newButton} items={newItems} />
        </div>
        {compact ? (
          <div style={{ width: 70, alignSelf: 'center' }} className="drag">
            <div className="no-drag" style={{ display: 'flex', justifyContent: 'center' }}>
              <ComputerFilterHeader hidden={hidden} setHidden={setHidden} manage={() => setSettings('computers')} compact />
            </div>
          </div>
        ) : null}
        {!compact ? (
          <div className="search">
            <Icon name="magnifyingglass" size={13} color="var(--secondary)" />
            <input
              ref={searchRef}
              value={search}
              placeholder="Search"
              aria-label="Search bots"
              spellCheck={false}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('')
                  searchRef.current?.blur()
                }
              }}
            />
            {search ? (
              <button className="search-clear" aria-label="Clear search" title="Clear search" onClick={() => setSearch('')}>
                <Icon name="xmark.circle.fill" size={13} color="var(--secondary)" />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="roster" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
          {!compact
            ? mismatchStores.map((s) => (
                <div key={s.computer.id} style={{ paddingBottom: 8 }}>
                  <StoreContext.Provider value={s}>
                    <UpdateNeededCard />
                  </StoreContext.Provider>
                </div>
              ))
            : null}
          {visibleRoster.map((item) => {
            const key = refKey(item.ref)
            const isSelected = sameRef(item.ref, selected)
            return (
              <button
                key={key}
                className="roster-row"
                style={{
                  padding: compact ? 0 : '0 8px',
                  background: isSelected ? 'var(--bubble-user)' : hovered === key ? 'var(--bubble-agent)' : 'transparent',
                }}
                aria-label={stores.length > 1 ? `${item.bot.name}, on ${item.store.hostName}` : item.bot.name}
                aria-selected={isSelected}
                title={stores.length > 1 ? `${item.bot.name} · ${item.store.hostName}` : item.bot.name}
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered((h) => (h === key ? null : h))}
                onClick={() => app.select(item.ref)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextBot({ target: { bot: item.bot, store: item.store }, x: e.clientX, y: e.clientY })
                }}
              >
                <BotRow bot={item.bot} store={item.store} compact={compact} usingComputer={item.store.screen?.agentBot === item.bot.id} members={isGroup(item.bot) ? item.store.members(item.bot) : noMembers} />
              </button>
            )
          })}
          {visibleRoster.length === 0 && !compact && mismatchStores.length === 0 ? (
            <div className="roster-empty">
              <div style={font(13, 'medium')}>{search ? 'No matching bots' : 'No bots yet'}</div>
              <div style={{ ...font(12), color: 'var(--secondary)' }}>{search ? 'Try another name or message.' : 'Use + to start a new chat.'}</div>
            </div>
          ) : null}
        </div>
        {compact ? (
          <div className="rail-actions">
            <IconButton title="New" icon="plus" size={36} buttonRef={railNewButton} disabled={!onlineStores.length} onClick={() => setRailNewMenu((o) => !o)} />
            <AnchoredMenu open={railNewMenu} onClose={() => setRailNewMenu(false)} anchor={railNewButton} items={newItems} />
            <IconButton title="Marketplace" icon="square.grid.2x2" size={36} onClick={openMarketplace} />
            <button className="rail-profile" style={{ background: showAccount ? 'var(--bubble-agent)' : undefined }} aria-label="Open account menu for Account" title="Account" onClick={() => setShowAccount((s) => !s)}>
              <ProfileAvatar />
            </button>
          </div>
        ) : (
          <div className="sidebar-footer">
            <button className="footer-row" onClick={openMarketplace}>
              <span className="footer-icon">
                <Icon name="square.grid.2x2" size={14} />
              </span>
              <span>Marketplace</span>
            </button>
            <button className={`footer-row account ${showAccount ? 'active' : ''}`} aria-label="Open account menu for Account" title="Account menu" onClick={() => setShowAccount((s) => !s)}>
              <ProfileAvatar />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Account</span>
            </button>
          </div>
        )}
      </aside>
      <div className="sidebar-divider" onPointerDown={onDividerDown} onPointerMove={onDividerMove} onPointerUp={() => (dragStart.current = null)} role="separator" aria-label="Resize sidebar" aria-valuenow={width} />
      <main className="detail">{detail}</main>

      {showAccount ? (
        <AccountPanelLayer
          compact={compact}
          approvals={app.approvals.length}
          onDismiss={() => setShowAccount(false)}
          onUsage={() => {
            setShowAccount(false)
            setSettings('usage')
          }}
          onSettings={() => {
            setShowAccount(false)
            setSettings('general')
          }}
        />
      ) : null}
      {contextBot ? (
        <div className="context-layer" onMouseDown={(e) => e.target === e.currentTarget && setContextBot(null)}>
          <DesktopActionMenu
            items={botActions(contextBot.target.bot, contextBot.target.store)}
            onDismiss={() => setContextBot(null)}
            style={{ left: Math.min(Math.max(8, contextBot.x), windowSize.width - 268), top: Math.min(Math.max(8, contextBot.y), Math.max(8, windowSize.height - 344)) }}
          />
        </div>
      ) : null}

      <Sheet open={editing !== null} onClose={() => setEditing(null)} width={520} height={Math.min(680, sheetHeight)}>
        {editing ? (
          <StoreContext.Provider value={editing.store}>
            <BotEditorView key={editing.id} draft={editing.draft} />
          </StoreContext.Provider>
        ) : null}
      </Sheet>
      <Sheet open={marketplace !== null} onClose={() => setMarketplace(null)} width={Math.min(920, windowSize.width - 80)} height={sheetHeight}>
        {marketplace && app.store(marketplace) ? (
          <StoreContext.Provider value={app.store(marketplace)!}>
            <MarketplaceView key={marketplace} computers={onlineStores.map((s) => ({ id: s.computer.id, name: s.hostName }))} computer={marketplace} onComputer={setMarketplace} />
          </StoreContext.Provider>
        ) : null}
      </Sheet>
      <Sheet open={settings !== null} onClose={() => setSettings(null)} width={Math.min(800, windowSize.width - 80)} height={Math.min(620, sheetHeight)}>
        {settings ? <SettingsView page={settings} /> : null}
      </Sheet>
      <Dialog
        open={newSessionBot !== null}
        title="Start a new session?"
        message="The conversation stays here, but the agent starts with a fresh context."
        actions={newSessionBot ? [{ title: 'New session', action: () => newSessionBot.store.newSession(newSessionBot.bot.id) }] : []}
        onClose={() => setNewSessionBot(null)}
      />
      <Dialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.bot.name ?? 'bot'}?`}
        message="Files it changed on your computer stay as they are."
        actions={confirmDelete ? [{ title: 'Delete bot and its conversation', destructive: true, action: () => confirmDelete.store.delete(confirmDelete.bot) }] : []}
        onClose={() => setConfirmDelete(null)}
      />
      <Dialog open={errorMessage !== null} title="Something went wrong" message={errorMessage} actions={[]} cancel="OK" onClose={() => app.clearErrors()} />
    </div>
  )
}

const noMembers: Bot[] = []

/** Which computer a new chat goes to, when more than one is online. */
function ComputerPicker({ stores, value, onChange }: { stores: BotStore[]; value: string; onChange: (id: string) => void }) {
  const options = useMemo(() => stores.map((s) => ({ id: s.computer.id, label: s.hostName })), [stores])
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 22px 0', ...font('callout') }}>
      <span style={{ color: 'var(--secondary)' }}>On</span>
      <ChoicePicker selection={value} options={options} onChange={onChange} />
    </div>
  )
}

function ProfileAvatar() {
  return (
    <span className="profile-avatar" aria-hidden>
      <Icon name="person.fill" size={15} weight="medium" color="var(--secondary)" />
    </span>
  )
}

interface PanelItem {
  title: string
  icon: string
  detail?: string | null
  chevron?: boolean
  disabled?: boolean
  destructive?: boolean
  action: () => void
}

/** The account menu: a window-local floating surface (no system menu styling). */
function AccountPanelLayer({ compact, approvals, onDismiss, onUsage, onSettings }: {
  compact: boolean
  approvals: number
  onDismiss: () => void
  onUsage: () => void
  onSettings: () => void
}) {
  const [page, setPage] = useState<'main' | 'support'>('main')
  const open = (url: string) => {
    onDismiss()
    window.codync.app.openExternal(url)
  }
  const items: PanelItem[] =
    page === 'support'
      ? [
          { title: 'Support', icon: 'chevron.left', action: () => setPage('main') },
          { title: 'Help & documentation', icon: 'book', chevron: true, action: () => open('https://github.com/leepokai/codync#readme') },
          { title: 'Report an issue', icon: 'bubble.left', chevron: true, action: () => open('https://github.com/leepokai/codync/issues') },
        ]
      : [
          { title: 'Usage', icon: 'gauge.with.dots.needle.33percent', chevron: true, action: onUsage },
          { title: 'Get Codync for mobile', icon: 'iphone', action: () => open('https://apps.apple.com/app/id6760984418') },
          { title: 'Support', icon: 'book.closed', chevron: true, action: () => setPage('support') },
          { title: 'Settings', icon: 'gearshape', detail: approvals > 0 ? String(approvals) : null, action: onSettings },
        ]
  return (
    <div className="context-layer" onMouseDown={(e) => e.target === e.currentTarget && onDismiss()}>
      <div className="account-panel" style={{ width: Math.min(260, window.innerWidth - 32), left: 16, bottom: compact ? 68 : 64 }}>
        <PanelRows
          items={items}
          onDismiss={onDismiss}
          after={(i) =>
            page === 'main' && i === 3 ? (
              <>
                <div className="panel-divider" />
                <div className="panel-identity">
                  <Icon name="person.crop.circle" size={15} />
                  <span style={{ ...font(12), flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Account</span>
                  <span style={font(11)}>Not signed in</span>
                </div>
              </>
            ) : page === 'support' && i === 0 ? (
              <div className="panel-divider" />
            ) : null
          }
        />
      </div>
    </div>
  )
}

function PanelRows({ items, onDismiss, after, dismissOnActivate = false }: { items: PanelItem[]; onDismiss: () => void; after?: (i: number) => ReactNode; dismissOnActivate?: boolean }) {
  const [highlighted, setHighlighted] = useState(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onDismiss()
      } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        setHighlighted((h) => (h + 1) % items.length)
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault()
        setHighlighted((h) => (h - 1 + items.length) % items.length)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const item = items[highlighted]
        if (item && !item.disabled) {
          if (dismissOnActivate) onDismiss()
          item.action()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, highlighted, onDismiss, dismissOnActivate])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {items.map((item, i) => (
        <div key={item.title}>
          <button
            className={`panel-row ${highlighted === i ? 'highlight' : ''}`}
            style={{ color: item.destructive ? 'var(--danger)' : 'var(--text)' }}
            disabled={item.disabled}
            onMouseEnter={() => setHighlighted(i)}
            onClick={() => {
              if (dismissOnActivate) onDismiss()
              item.action()
            }}
          >
            <span style={{ width: 20, display: 'flex', justifyContent: 'center' }}>
              <Icon name={item.icon} size={14} />
            </span>
            <span style={{ ...font(12), flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span>
            {item.detail ? <span style={{ ...font(13), color: 'var(--secondary)' }}>{item.detail}</span> : null}
            {item.chevron ? <Icon name="chevron.right" size={11} color="var(--secondary)" /> : null}
          </button>
          {after?.(i)}
        </div>
      ))}
    </div>
  )
}

/** The roster's right-click actions, shared by pointer and keyboard. */
function DesktopActionMenu({ items, onDismiss, style }: { items: MenuItem[]; onDismiss: () => void; style: React.CSSProperties }) {
  const rows = items.map<PanelItem>((m) => ({ title: m.title, icon: m.icon ?? 'circle', destructive: m.destructive, action: m.action }))
  return (
    <div className="action-menu" style={style}>
      <PanelRows
        items={rows}
        onDismiss={onDismiss}
        dismissOnActivate
        after={(i) => (items[i + 1]?.divider ? <div className="panel-divider" /> : null)}
      />
    </div>
  )
}

