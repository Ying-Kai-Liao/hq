import { useEffect, useMemo, useState } from 'react'
import { Button, CardSection, DropdownMenu, IconButton, SegmentedChoice, Switch } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader, Sheet } from '../../components/Overlay'
import { useModel } from '../../lib/observable'
import { useStore } from '../../store/context'
import { MemoryStore, authorLabel, type MemoryEntry } from '../../store/memory-store'
import { relativeTime } from '../thread/chat-items'
import { type FileTarget, MemoryFileSheet, fileRows } from './MemoryFiles'
import './memory.css'

type Section = 'yours' | 'bot' | 'dreams' | 'project'

/** A bot's memory: what all your bots know about you, what this one knows, its dreams and its project's notes. */
export function MemoryCard({ botId }: { botId: string }) {
  const host = useStore()
  const memory = useModel(useMemo(() => new MemoryStore(botId, () => host.ready()), [botId, host]))
  const bot = host.bots.get(botId)
  const [section, setSection] = useState<Section>('bot')
  const [draft, setDraft] = useState<{ id?: number; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [file, setFile] = useState<FileTarget | null>(null)
  // Memory changes anywhere move the bot's `memoryRev`: fetch again.
  useEffect(() => { void memory.load() }, [memory, bot?.memoryRev, bot?.sharedMemory])

  const view = memory.view
  const sections: { id: Section; label: string }[] = [
    { id: 'yours', label: 'About you' }, { id: 'bot', label: 'This bot' }, { id: 'dreams', label: 'Dreams' },
    ...(view?.projectMemory ? [{ id: 'project' as const, label: 'Project' }] : []),
  ]
  const layer = section === 'yours' ? view?.yours : section === 'bot' ? view?.bot : undefined
  const save = () => {
    if (!draft?.text.trim()) return
    void memory.mutate('saveMemory', { id: draft.id, shared: section === 'yours', text: draft.text.trim() }).then((ok) => { if (ok) setDraft(null) })
  }

  return <>
    <CardSection title="Memory" accessory={layer ? <div className="memory-header-actions">
      <IconButton title="Add memory" icon="plus" onClick={() => setDraft({ text: '' })} disabled={memory.busy} />
      <DropdownMenu className="icon-button memory-menu" title="More" items={() => [
        { title: 'Refresh', icon: 'arrow.clockwise', action: () => void memory.load() },
        { title: 'Forget everything here', icon: 'trash', destructive: true, divider: true, action: () => setConfirmClear(true) },
      ]}><Icon name="ellipsis" size={14} weight="medium" /></DropdownMenu>
    </div> : null}>
      <SegmentedChoice selection={section} options={sections} onChange={setSection} />
      {memory.error && <p role="alert" className="memory-error">{memory.error}</p>}
      {!view && !memory.error && <p className="memory-muted">Loading memory…</p>}
      {view && bot && section === 'yours' && <Switch on={bot.sharedMemory} disabled={memory.busy} onChange={(on) => host.setSharedMemory(bot, on)}>
        Use what your bots share
      </Switch>}
      {layer && [
        <p key="note" className="memory-muted">{section === 'yours'
          ? 'Your name, time zone, people and lasting preferences, shared by your bots.'
          : 'What this bot learned about you.'} {layer.used} of {layer.cap} in use.</p>,
        ...(layer.entries.length ? [] : [<div key="empty" className="memory-empty">
          <Icon name="brain" size={20} color="var(--tertiary)" />
          <span>{section === 'yours' ? 'Nothing shared yet.' : 'Nothing yet. What this bot learns about you shows up here, and you can change any of it.'}</span>
        </div>]),
        ...layer.entries.map((entry) => <EntryRow key={entry.id} entry={entry} memory={memory} edit={() => setDraft({ id: entry.id, text: entry.text })} />),
        ...(view?.files ? fileRows(memory, view.files, section === 'yours', setFile) : []),
      ]}
      {view && section === 'dreams' && [
        <p key="note" className="memory-muted">Between chats the bot tidies its memory from your own words. Each run can be undone.</p>,
        ...(view.dreams.length ? [] : [<div key="empty" className="memory-empty"><Icon name="moon" size={20} color="var(--tertiary)" /><span>No dreams yet.</span></div>]),
        ...view.dreams.map((dream) => <div className="memory-item fade-in" key={dream.id}>
          <div className="memory-content">
            <strong>{relativeTime.day(dream.at)}{dream.undone ? ' · undone' : ''}</strong>
            {dream.added.map((c) => <span key={`a${c.id}`}>+ {c.text}</span>)}
            {dream.archived.map((c) => <span key={`r${c.id}`} className="memory-archived">− {c.text}</span>)}
            {(dream.files ?? []).map((f) => <span key={`f${f.version}`} className="memory-muted">Added to {f.name}</span>)}
          </div>
          {!dream.undone && <IconButton title="Undo this dream" icon="arrow.uturn.backward" disabled={memory.busy} onClick={() => void memory.mutate('undoDream', { id: dream.id })} />}
        </div>),
      ]}
      {view?.projectMemory && section === 'project' && <div className="memory-content">
        <p className="memory-muted">The project folder's own notes, kept by Claude Code. Read-only here.</p>
        <small className="memory-muted">{view.projectMemory.path}</small>
        <pre className="memory-history">{view.projectMemory.text}</pre>
      </div>}
    </CardSection>
    <Sheet open={draft !== null} onClose={() => setDraft(null)} width={520}>
      <ModalHeader title={draft?.id ? 'Edit memory' : section === 'yours' ? 'Add to what your bots share' : 'Add memory'} />
      {draft && <div className="memory-editor">
        <textarea aria-label="Memory" rows={3} autoFocus placeholder="One short fact" value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save() } }} />
        {memory.error && <p role="alert" className="memory-error">{memory.error}</p>}
        <Button disabled={memory.busy || !draft.text.trim()} onClick={save}>{memory.busy ? 'Saving…' : 'Save'}</Button>
      </div>}
    </Sheet>
    <Sheet open={file !== null} onClose={() => setFile(null)} width={640}>
      {file && <MemoryFileSheet memory={memory} target={file} onClose={() => setFile(null)} />}
    </Sheet>
    <Dialog open={confirmClear}
      title={section === 'yours' ? 'Forget everything your bots share about you?' : 'Forget everything this bot remembers?'}
      actions={[{ title: 'Forget everything', destructive: true, action: () => { void memory.mutate('clearMemory', { shared: section === 'yours' }) } }]}
      onClose={() => setConfirmClear(false)} />
  </>
}

function EntryRow({ entry, memory, edit }: { entry: MemoryEntry; memory: MemoryStore; edit: () => void }) {
  const host = useStore()
  const archived = entry.state === 'archived'
  return <div className="memory-item fade-in">
    <button className="press memory-content" onClick={edit}>
      <strong className={archived ? 'memory-archived' : undefined}>{entry.pinned && <Icon name="pin.fill" size={10} color="var(--secondary)" />}{entry.text}</strong>
      <small>{authorLabel(entry, (id) => host.authorName(id))} · {relativeTime.day(entry.updatedAt)}{archived ? ' · archived' : ''}</small>
    </button>
    <DropdownMenu className="icon-button memory-menu" title="Memory actions" items={() => [
      { title: 'Edit', icon: 'pencil', action: edit },
      { title: entry.pinned ? 'Unpin' : 'Pin', icon: entry.pinned ? 'pin.slash' : 'pin', action: () => void memory.mutate('pinMemory', { id: entry.id, pinned: !entry.pinned }) },
      { title: archived ? 'Bring back' : 'Archive', icon: archived ? 'tray.and.arrow.up' : 'archivebox', action: () => void memory.mutate('archiveMemory', { id: entry.id, archived: !archived }) },
      { title: 'Forget', icon: 'trash', destructive: true, divider: true, action: () => void memory.mutate('forgetMemory', { id: entry.id }) },
    ]}><Icon name="ellipsis" size={14} weight="medium" /></DropdownMenu>
  </div>
}
