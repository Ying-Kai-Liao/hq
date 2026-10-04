import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { draftOf, isGroup, isWorkingIn, type Bot, type BotDraft } from '@shared/models'
import { BotAvatar, GroupAvatar } from '../../components/Avatar'
import { IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, Sheet } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { UpdateNeededCard } from '../UpdateNeededCard'
import { buildChat, relativeTime, type ChatItem } from './chat-items'
import { ChatRow, WorkingIndicator } from './ChatRows'
import { Composer } from './Composer'
import { DetailsPanel } from './DetailsPanel'
import { RepliesView } from './RepliesView'
import { TraceView } from './TraceView'
import { useReading } from './reading'
import { GroupEditorView } from '../bots/GroupEditorView'
import { BotTemplateView } from '../bots/BotTemplateView'
import { RoutinesView } from '../routines/RoutinesView'
import { CallView } from '../call/CallView'
import './thread.css'

const WIDE = 680

/**
 * One endless conversation with a bot or a group chat. Only deliberate messages show here; tool
 * calls and thinking live in the "Full conversation" sheet. Any message can start a thread,
 * which opens beside the chat.
 */
export function ThreadView({ botId }: { botId: string }) {
  const store = useStore()
  const bot = store.bots.get(botId) ?? null
  const [showTrace, setShowTrace] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [editingGroup, setEditingGroup] = useState(false)
  const [templateDraft, setTemplateDraft] = useState<BotDraft | null>(null)
  const [confirmNewSession, setConfirmNewSession] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Bot | null>(null)
  const [showSettings, setShowSettings] = useState(true)
  const [editingDetails, setEditingDetails] = useState(false)
  const [compactDetails, setCompactDetails] = useState(false)
  const [calling, setCalling] = useState(false)
  const [callSpeaking, setCallSpeaking] = useState(false)
  const interruptCall = useRef<(() => void) | null>(null)
  const [routineId, setRoutineId] = useState<string | null>(null)
  const [routineRequest, setRoutineRequest] = useState(0)
  const [showRoutines, setShowRoutines] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useReading(store, botId, null)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([e]) => setWidth(e!.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const wide = width >= WIDE
  const toggleDetails = useCallback(() => {
    if (!wide) setCompactDetails((c) => !c)
    else setShowSettings((s) => !s)
  }, [wide])

  useEffect(
    () =>
      window.codync.app.onCommand((c) => {
        if (c.kind === 'toggleDetails') toggleDetails()
      }),
    [toggleDetails],
  )

  const openTrace = useCallback(() => setShowTrace(true), [])
  const openThreadOn = useCallback((root: { id: string }) => setOpenThread(root.id), [])
  const closeThread = useCallback(() => setOpenThread(null), [])

  const presentRoutine = (id: string | null) => {
    setRoutineId(id)
    setRoutineRequest((r) => r + 1)
    setEditingDetails(false)
    setOpenThread(null)
    setShowSettings(true)
    if (!wide) setCompactDetails(true)
  }

  const details = (
    <DetailsPanel
      key={routineRequest}
      botId={botId}
      routineId={routineId}
      editing={editingDetails}
      setEditing={setEditingDetails}
      editGroup={() => setEditingGroup(true)}
      share={() => {
        setCompactDetails(false)
        if (bot) setTemplateDraft(draftOf(bot))
      }}
      close={() => {
        setShowSettings(false)
        setCompactDetails(false)
      }}
    />
  )

  return (
    <div className="thread-view" ref={root}>
      <div className="conversation">
        <div className="top-chrome">
          <TopFade />
          <div className="top-chrome-row">
            <span style={{ flex: 1 }} />
            {!showSettings || !wide ? (
              <span className="frosted-circle">
                <IconButton title="Conversation details" icon="chevron.left.2" onClick={toggleDetails} />
              </span>
            ) : null}
          </div>
          <button className="title-pill" onClick={toggleDetails} aria-label="View conversation details" title="View conversation details">
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {bot ? isGroup(bot) ? <GroupAvatar members={store.members(bot)} size={22} /> : <BotAvatar bot={bot} size={22} /> : null}
              <span style={{ ...font(14, 'semibold'), color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bot?.name ?? ''}</span>
            </span>
            {store.shownConnection.kind !== 'online' || store.mismatch ? <ConnectionSubtitle /> : null}
          </button>
        </div>
        <Transcript botId={botId} openTrace={openTrace} openThread={openThreadOn} openRoutine={presentRoutine} />
        <div className="composer-dock">
          {store.mismatch ? (
            <div style={{ padding: '0 16px 8px' }}>
              <UpdateNeededCard />
            </div>
          ) : (
            <Composer
              botId={botId}
              onCall={!calling && bot && !isGroup(bot) ? () => setCalling(true) : null}
              onInterrupt={callSpeaking ? () => interruptCall.current?.() : null}
            />
          )}
        </div>
        {calling ? (
          <div className="call-overlay">
            <CallView botId={botId} onSpeaking={setCallSpeaking} interrupt={interruptCall} onEnd={() => setCalling(false)} />
          </div>
        ) : null}
      </div>
      {openThread && wide ? (
        <SidePanel key={openThread} width={Math.min(420, width * 0.45)}>
          <RepliesView botId={botId} rootId={openThread} close={closeThread} />
        </SidePanel>
      ) : showSettings && wide ? (
        <SidePanel width={292}>{details}</SidePanel>
      ) : null}

      <Sheet open={compactDetails} onClose={() => setCompactDetails(false)} width={340} height={600}>
        {details}
      </Sheet>
      <Sheet open={openThread !== null && !wide} onClose={closeThread} width={440} height={600}>
        {openThread ? <RepliesView botId={botId} rootId={openThread} close={closeThread} /> : null}
      </Sheet>
      <Sheet open={showTrace} onClose={() => setShowTrace(false)} width={620} height={560}>
        <TraceView botId={botId} />
      </Sheet>
      <Sheet open={templateDraft !== null} onClose={() => setTemplateDraft(null)}>
        {templateDraft ? <BotTemplateView draft={templateDraft} /> : null}
      </Sheet>
      <Sheet open={editingGroup} onClose={() => setEditingGroup(false)} width={420} height={560}>
        <GroupEditorView group={bot} />
      </Sheet>
      <Sheet open={showRoutines} onClose={() => setShowRoutines(false)} width={440} height={580}>
        <div style={{ overflowY: 'auto', padding: 20 }}>
          <RoutinesView botId={botId} initialId={routineId} onClose={() => setShowRoutines(false)} />
        </div>
      </Sheet>
      <Dialog
        open={confirmNewSession}
        title="Start a new session?"
        message="The conversation stays here, but the agent starts with a fresh context."
        actions={[{ title: 'New session', action: () => store.newSession(botId) }]}
        onClose={() => setConfirmNewSession(false)}
      />
      <Dialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? 'bot'}?`}
        message={confirmDelete && isGroup(confirmDelete) ? 'Its bots and their own chats stay.' : 'Files it changed on your computer stay as they are.'}
        actions={confirmDelete ? [{ title: 'Delete bot and its conversation', destructive: true, action: () => store.delete(confirmDelete) }] : []}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  )
}

/** The panel beside the chat (a thread, or the bot's details), sliding in from the trailing edge. */
function SidePanel({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="side-panel" style={{ width: width + 1 }}>
      <div className="side-panel-border" />
      <div style={{ width, height: '100%' }}>{children}</div>
    </div>
  )
}

/** The top edge of the chat: messages fade out gradually as they scroll under the title pill. */
function TopFade() {
  return <div className="top-fade" />
}

function ConnectionSubtitle() {
  const store = useStore()
  const connecting = store.shownConnection.kind === 'connecting'
  const symbol = store.connection.kind !== 'online' ? 'wifi.slash' : store.hostRoute === 'relay' ? 'cloud' : store.hostRoute === 'direct' ? 'wifi' : store.hostRoute === 'loopback' ? 'desktopcomputer' : 'network'
  const description = (() => {
    switch (store.shownConnection.kind) {
      case 'connecting':
        return 'Connecting'
      case 'computerOffline':
      case 'offline':
        return 'Offline'
      case 'unauthorized':
        return 'No access'
      case 'unpaired':
        return 'Not paired'
    }
    if (store.mismatch) return 'Needs update'
    return store.hostRoute === 'relay' ? 'Connected through Cloudflare' : store.hostRoute === 'direct' ? 'Connected over Wi-Fi or Tailscale' : store.hostRoute === 'loopback' ? 'Connected locally' : 'Connected'
  })()
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...font(10, 'medium'), color: 'var(--secondary)' }} title={`${store.hostName} · ${description}`} aria-label={`${store.hostName}, ${description}`}>
      <span style={{ width: 12, display: 'flex', justifyContent: 'center' }}>{connecting ? <Spinner size={8} /> : <Icon name={symbol} size={8} weight="medium" />}</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{store.connectionLabel}</span>
    </span>
  )
}

/** The messages: every loaded message, brought to the newest as it changes while the reader is at the bottom. */
function Transcript({ botId, openTrace, openThread, openRoutine }: { botId: string; openTrace: () => void; openThread: (e: { id: string }) => void; openRoutine: (id: string | null) => void }) {
  const store = useStore()
  const bot = store.bots.get(botId) ?? null
  const thread = store.chat(botId)
  const live = !!bot && isWorkingIn(bot, botId, null) && !store.isOffline
  const items = buildChat(thread, live)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const seen = useRef<Set<string> | null>(null)
  const last = items[items.length - 1]

  // New items (after the first render) slide up from the bottom.
  const fresh = new Set<string>()
  if (seen.current) for (const item of items) if (!seen.current.has(item.id)) fresh.add(item.id)
  useEffect(() => {
    seen.current = new Set(items.map((i) => i.id))
  })

  const toBottom = (smooth: boolean) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  useLayoutEffect(() => toBottom(false), [])
  const lastText = last?.kind === 'entry' ? last.entry.data.text : undefined
  const lastIsUser = last?.kind === 'entry' && last.entry.kind === 'user'
  useLayoutEffect(() => {
    if (atBottom.current || lastIsUser) toBottom(true)
  }, [last?.id, lastIsUser])
  useLayoutEffect(() => {
    if (atBottom.current) toBottom(false)
  }, [lastText, live])

  // The text size changes the layout: stay at the bottom if the reader was there.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (atBottom.current) toBottom(false)
    })
    observer.observe(el.firstElementChild!)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
    >
      <div className="transcript-content">
        {!store.historyComplete.has(botId) && thread.length >= 50 ? (
          <button className="load-earlier" onClick={() => void store.loadOlder(botId)}>
            Load earlier messages
          </button>
        ) : null}
        {items.length === 0 && bot ? <div style={{ paddingTop: 40 }}>{isGroup(bot) ? <GroupIntroCard group={bot} /> : <IntroCard bot={bot} />}</div> : null}
        {items.map((item) => (
          <div key={item.id} className={fresh.has(item.id) && item.id === last?.id ? 'enter' : undefined}>
            <Row item={item} chat={bot} openTrace={openTrace} openThread={openThread} openRoutine={openRoutine} />
          </div>
        ))}
        {bot && live ? (
          <div style={{ paddingTop: 6 }}>
            <WorkingIndicator bot={bot} thinking={store.currentThinking(botId, null)} />
          </div>
        ) : null}
        <div style={{ height: 8 }} />
      </div>
    </div>
  )
}

function Row({ item, chat, openTrace, openThread, openRoutine }: { item: ChatItem; chat: Bot | null; openTrace: () => void; openThread: (e: { id: string }) => void; openRoutine: (id: string | null) => void }) {
  if (item.kind === 'separator') {
    return <div style={{ ...font('footnote'), color: 'var(--tertiary)', textAlign: 'center', padding: '18px 0 6px' }}>{relativeTime.separator(item.date)}</div>
  }
  const e = item.entry
  if (e.kind === 'notice' && e.data.routineId) {
    return (
      <button onClick={() => openRoutine(e.data.routineId!)} style={{ display: 'flex', alignItems: 'center', gap: 6, ...font('footnote'), color: 'var(--secondary)', padding: '10px 0', margin: '0 auto' }}>
        <Icon name="clock.arrow.circlepath" size={10} />
        {e.data.text ?? 'Routine'}
      </button>
    )
  }
  return <ChatRow entry={e} groupStart={item.groupStart} chat={chat} openTrace={openTrace} openThread={openThread} />
}

/** The start of an empty group chat: who's in it and how the room works. */
function GroupIntroCard({ group }: { group: Bot }) {
  const store = useStore()
  const members = store.members(group)
  return (
    <div className="intro-card">
      <GroupAvatar members={members} size={72} />
      <div style={{ ...font('title2', 'semibold'), color: 'var(--text)' }}>{group.name}</div>
      <div style={{ ...font('subheadline'), color: 'var(--secondary)' }}>{members.map((m) => m.name).join(' · ')}</div>
      {group.description ? <div style={{ ...font('subheadline'), color: 'var(--secondary)' }}>{group.description}</div> : null}
      <div style={{ ...font('footnote'), color: 'var(--tertiary)', paddingTop: 4 }}>Everyone answers in turn. @mention a bot to ask just that one. Each bot works in its own folder.</div>
    </div>
  )
}

function IntroCard({ bot }: { bot: Bot }) {
  const store = useStore()
  return (
    <div className="intro-card">
      <BotAvatar bot={bot} size={72} />
      <div style={{ ...font('title2', 'semibold'), color: 'var(--text)' }}>{bot.name}</div>
      <div style={{ ...font('footnote', undefined, 'monospaced'), color: 'var(--tertiary)' }}>
        {bot.managedWorkspace ? `${store.backendName(bot.backend)} · Personal workspace` : `${store.backendName(bot.backend)} in ${bot.cwd}`}
      </div>
      {bot.description ? <div style={{ ...font('subheadline'), color: 'var(--secondary)' }}>{bot.description}</div> : null}
      <div style={{ ...font('footnote'), color: 'var(--tertiary)', paddingTop: 4 }}>Tell it what you need. You'll get a notification when it's done or needs you.</div>
    </div>
  )
}
