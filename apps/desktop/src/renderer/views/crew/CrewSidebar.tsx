import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { boardWaiting, buildBoard, type BoardTarget } from '@shared/board'
import { resultList, searchCrew, type CrewHit, type CrewSearchSource } from '@shared/crew-search'
import { isGroup } from '@shared/models'
import { isTask, taskLastAt, taskTitle } from '@shared/tasks'
import { IconButton } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { CrewBoardSwitch, NewChatButton, SkyPatch, type CrewBoard } from '../../components/kith'
import { AnchoredMenu, type MenuItem } from '../../components/Overlay'
import { Text } from '../../components/Text'
import { START_CALL_EVENT } from '../../lib/call-event'
import { useAccount } from '../../store/account'
import { refKey, type BotRef, type RosterItem } from '../../store/app-model'
import { useApp } from '../../store/context'
import type { useComputerRoster } from '../../store/computer-roster'
import { BotRoster } from '../BotRoster'
import { useDictation } from '../thread/dictation'
import { UpdateBadge } from '../UpdateButton'
import { BoardList } from './BoardList'
import { SearchResults } from './SearchResults'
import '../sidebar-footer.css'
import './crew-sidebar.css'

const isMac = window.kith.platform === 'darwin'

/** The sidebar of the main window: Crew or Board, the search dock, and the narrow rail. */
export function CrewSidebar({ compact, roster, items, listRef, onListKey, onContext, searchRef, newItems, canCreate, accountOpen, onAccount, onExtensions, filter, emptyNote }: {
  compact: boolean
  roster: ReturnType<typeof useComputerRoster>
  /** Every room shown, for search. */
  items: RosterItem[]
  listRef: RefObject<HTMLDivElement | null>
  onListKey: (e: KeyboardEvent) => void
  onContext: Parameters<typeof BotRoster>[0]['onContext']
  /** ⌘F focuses this. */
  searchRef: RefObject<HTMLInputElement | null>
  newItems: () => MenuItem[]
  canCreate: boolean
  accountOpen: boolean
  onAccount: () => void
  onExtensions: () => void
  /** The computer filter, when there is anything to filter. */
  filter: ReactNode
  emptyNote: ReactNode
}) {
  const app = useApp()
  const [mode, setMode] = useState<CrewBoard>('crew')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [newMenu, setNewMenu] = useState(false)
  const newButton = useRef<HTMLDivElement>(null)
  const dictation = useDictation(query, setQuery)
  const searching = query.trim().length > 0

  // The stores change in place and re-render the window on every change, so these are built on each render.
  const board = buildBoard(roster.sections.map(({ computer, store }) => ({
    id: computer.id,
    hostName: store.hostName,
    trouble: store.isOffline ? 'unreachable' : store.shownConnection.kind === 'connecting' ? 'catchingUp' : null,
    bots: store.roster,
    entries: store.entries,
    guestPrompts: store.guestPrompts,
  })))

  // ⌥⌘1 / ⌥⌘2 (Ctrl+Alt elsewhere) switch between Crew and Board.
  useEffect(() => {
    if (compact) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || !(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey) return
      const next = e.code === 'Digit1' ? 'crew' : e.code === 'Digit2' ? 'board' : null
      if (!next) return
      e.preventDefault()
      setMode(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact])

  const byKey = useMemo(() => new Map(items.map((i) => [refKey(i.ref), i])), [items])
  const botOf = (t: BoardTarget) => byKey.get(refKey(t))?.bot
  const openRef = (ref: BotRef) => {
    if (byKey.has(refKey(ref))) app.select(ref)
  }

  const sources: CrewSearchSource[] = !searching ? [] : items.map((i) => ({
      ref: i.ref,
      name: i.bot.name,
      description: i.bot.description,
      lastMessage: i.bot.lastMessage ?? '',
      isGroup: isGroup(i.bot),
      threads: i.store.allEntries(i.bot.id).filter(isTask).map((t) => ({ id: t.id, title: taskTitle(t), at: taskLastAt(t) })),
  }))
  const results = searching ? searchCrew(sources, query) : null
  const hits = results ? resultList(results) : []

  const openHit = (hit: CrewHit | undefined) => {
    if (!hit) return
    openRef(hit.ref)
    setQuery('')
  }
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const digit = Number(e.key)
    if ((isMac ? e.metaKey : e.ctrlKey) && digit >= 1 && digit <= 9) {
      e.preventDefault()
      openHit(hits[digit - 1])
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (hits.length ? (i + step + hits.length) % hits.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openHit(hits[active] ?? hits[0])
    } else if (e.key === 'Escape') {
      setQuery('')
    }
  }
  const change = (text: string) => {
    setQuery(text)
    setActive(0)
  }

  const profile = <SidebarProfile accountOpen={accountOpen} onAccount={onAccount} />
  const newMenuNode = <AnchoredMenu open={newMenu} onClose={() => setNewMenu(false)} anchor={newButton} items={newItems} />

  if (compact) {
    return (
      <>
        <div className="cs-rail-top drag">
          <div className="no-drag cs-rail-stack">
            {profile}
            <div ref={newButton}>
              <NewChatButton onClick={() => canCreate && setNewMenu(true)} />
            </div>
          </div>
          {newMenuNode}
        </div>
        <div className="roster" ref={listRef} tabIndex={0} onKeyDown={onListKey}>
          <BotRoster roster={roster} compact onContext={onContext} />
        </div>
        <div className="cs-rail-foot">
          {filter}
          <IconButton title="Extensions" icon="square.grid.2x2" size={36} onClick={onExtensions} />
          <UpdateBadge size={32} />
        </div>
      </>
    )
  }

  const body = searching && results ? (
    <SearchResults results={results} query={query} active={active} bots={(hit) => botOf(hit.ref)} onActive={setActive} open={openHit} />
  ) : mode === 'board' ? (
    <BoardList board={board} selected={app.selection} bots={botOf} stores={roster.sections.map((s) => s.store)} open={openRef} />
  ) : (
    <>
      {filter ? <div className="cs-filter no-drag">{filter}</div> : null}
      <BotRoster roster={roster} compact={false} onContext={onContext} />
      {emptyNote}
    </>
  )
  const callShown = !searching && !!app.selection
  return (
    <>
      <div className="cs-top drag">
        <div className="cs-top-inner no-drag">
          {profile}
          <CrewBoardSwitch value={mode} onChange={setMode} boardCount={boardWaiting(board)} />
          <div ref={newButton}>
            <NewChatButton onClick={() => canCreate && setNewMenu(true)} />
          </div>
        </div>
        {newMenuNode}
      </div>
      <div className="roster" ref={listRef} tabIndex={0} onKeyDown={mode === 'crew' && !searching ? onListKey : undefined}>
        {body}
      </div>
      <div className="cs-dock">
        <div className={`cs-box kith-glass ${searching ? 'typing' : ''}`}>
          <button className="cs-box-plus" aria-label="New" disabled={!canCreate} onClick={() => setNewMenu(true)}>
            <Icon name="plus" size={15} weight="medium" />
          </button>
          <input
            ref={searchRef}
            className="cs-box-field"
            value={query}
            placeholder="Find or ask…"
            aria-label="Find a room, agent or thread"
            spellCheck={false}
            onChange={(e) => change(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {searching ? (
            <button className="cs-box-send" aria-label="Open the top match" disabled={!hits.length} onClick={() => openHit(hits[active] ?? hits[0])}>
              <Icon name="arrow.up" size={13} weight="bold" />
            </button>
          ) : window.kith.speech.available ? (
            <button className={`cs-box-mic ${dictation.listening ? 'on' : ''}`} aria-label={dictation.listening ? 'Stop dictating' : 'Dictate'} aria-pressed={dictation.listening} onClick={dictation.toggle}>
              <Icon name={dictation.listening ? 'mic.fill' : 'mic'} size={15} weight="medium" />
            </button>
          ) : null}
        </div>
        <div className={`cs-call-slot ${callShown ? 'shown' : ''}`} aria-hidden={!callShown} inert={!callShown}>
          <button className="cs-call kith-glass" aria-label="Call" title="Call" tabIndex={callShown ? 0 : -1} onClick={() => window.dispatchEvent(new Event(START_CALL_EVENT))}>
            <Icon name="phone.fill" size={16} />
          </button>
        </div>
      </div>
    </>
  )
}

/** The profile picture: the account's photo, else a piece of sky (you are always dawn). */
function SidebarProfile({ accountOpen, onAccount }: { accountOpen: boolean; onAccount: () => void }) {
  const { user } = useAccount()
  return (
    <button className={`cs-profile ${accountOpen ? 'open' : ''}`} aria-label="Open account menu for Account" aria-expanded={accountOpen} title="Account" onClick={onAccount}>
      {user?.avatarURL ? <img className="cs-profile-photo" src={user.avatarURL} alt="" /> : <SkyPatch id={user?.userId ?? 'you'} you size={30} />}
    </button>
  )
}

/** Shown in the list when nothing is: no bots yet, or no computer. */
export function RosterEmpty({ online }: { online: boolean }) {
  return (
    <div className="roster-empty">
      <Text as="div" size="body" weight="medium">{online ? 'No bots yet' : 'Waiting for a computer'}</Text>
      {online ? <Text as="div" size="callout" tone="secondary">Use the new chat button to start one.</Text> : null}
    </div>
  )
}
