import { useEffect, useState, type ReactElement } from 'react'
import { CardForm, CardSection, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader } from '../../components/Overlay'
import { useApp, useStore } from '../../store/context'
import { type MemoryFile, type MemoryFileDetail, type MemoryFiles, type MemoryStore, versionLabel } from '../../store/memory-store'
import { Field } from '../marketplace/pieces'
import { relativeTime } from '../thread/chat-items'

/** What a note sheet opens: a file, or (`name` null) a new one. */
export interface FileTarget { name: string | null; shared: boolean }

const TEMPLATE = '---\ndescription: When to read this note\n---\n'

/** One layer's long-form notes, as rows under its entries: name, description, size and date, marked past a cap. */
export function fileRows(memory: MemoryStore, files: MemoryFiles, shared: boolean, open: (target: FileTarget) => void): ReactElement[] {
  const folder = shared ? files.yours : files.bot
  const live = folder.files.filter((f) => !f.deleted)
  const gone = folder.files.filter((f) => f.deleted)
  return [
    <div key="notes" className="memory-notes-header">
      <span>Notes</span>
      <IconButton title="New note" icon="doc.badge.plus" disabled={memory.busy} onClick={() => open({ name: null, shared })} />
    </div>,
    ...(live.length === 0 ? [<p key="notes-empty" className="memory-muted">Longer notes, one topic each. The bot reads one when its topic comes up.</p>] : []),
    ...(live.length > files.folderCap ? [<p key="notes-cap" className="memory-attention">{live.length} notes, over the {files.folderCap}-note cap. Merge some.</p>] : []),
    ...[...live, ...gone].map((file) => <FileRow key={file.name} file={file} cap={files.cap} open={() => open({ name: file.name, shared })} />),
  ]
}

function FileRow({ file, cap, open }: { file: MemoryFile; cap: number; open: () => void }) {
  const over = !file.deleted && file.tokens > cap
  return <button className="press memory-content fade-in" onClick={open}>
    <strong className={file.deleted ? 'memory-archived' : undefined}><Icon name={file.deleted ? 'doc' : 'doc.text'} size={11} />{file.name}</strong>
    {file.description && !file.deleted ? <span className="memory-muted">{file.description}</span> : null}
    <small className={over ? 'memory-attention' : undefined}>
      {file.deleted ? `Deleted ${relativeTime.day(file.updatedAt)}` : `${file.tokens} tokens${over ? `, over the ${cap} cap` : ''} · ${relativeTime.day(file.updatedAt)}`}
    </small>
  </button>
}

/** One note: read it, edit it, open it in an editor, delete it, or bring back an earlier version. */
export function MemoryFileSheet({ memory, target, onClose }: { memory: MemoryStore; target: FileTarget; onClose: () => void }) {
  const host = useStore()
  // A note opens in an editor only when the host is this computer.
  const local = useApp().local === host
  const [detail, setDetail] = useState<MemoryFileDetail | null>(null)
  const [draft, setDraft] = useState<string | null>(target.name ? null : TEMPLATE)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    if (target.name) void memory.file(target.name, target.shared).then(setDetail)
  }, [memory, target])

  const validName = /^[a-z0-9-]+\.md$/.test(name)
  const change = async (change: { content?: string; version?: number }) => {
    const file = target.name ?? name
    const ok = await memory.changeFile(file, target.shared, target.name ? detail?.hash ?? null : null, change)
    if (!ok) return
    if (!target.name || (change.content === undefined && change.version === undefined)) return onClose()
    setDraft(null)
    setDetail(await memory.file(file, target.shared))
  }

  const actions = memory.busy ? <Spinner /> : draft !== null
    ? <IconButton title="Save" icon="checkmark" disabled={!draft.trim() || (!target.name && !validName)} onClick={() => void change({ content: draft })} />
    : detail?.content != null ? <div className="memory-header-actions">
      <IconButton title="Edit" icon="pencil" onClick={() => setDraft(detail.content)} />
      {local ? <IconButton title="Open in your editor" icon="arrow.up.right.square" onClick={() => window.codync.app.openMemoryFile(detail.path)} /> : null}
      <IconButton title="Delete" icon="trash" onClick={() => setConfirmDelete(true)} />
    </div> : null

  return <div className="memory-file-sheet">
    <ModalHeader title={target.name ?? 'New note'} trailing={actions} />
    <CardForm>
      {memory.error ? <CardSection><p role="alert" className="memory-error">{memory.error}</p></CardSection> : null}
      {draft !== null ? <>
        {!target.name ? <CardSection footer="Lowercase letters, digits and dashes, ending in .md.">
          <Field value={name} onChange={setName} placeholder="people.md" label="File name" mono />
        </CardSection> : null}
        <CardSection footer="The description: line says when the bot should read it.">
          <Field value={draft} onChange={setDraft} label="Note" lines={[12, 32]} mono />
        </CardSection>
      </> : detail ? <>
        <CardSection footer={detail.path}>
          {detail.content != null ? <pre className="memory-file-text">{detail.content}</pre> : <p className="memory-muted">Deleted. Bring back a version below.</p>}
        </CardSection>
        <CardSection title="Versions">
          {detail.versions.map((version) => <div key={version.id} className="memory-item">
            <div className="memory-content">
              <span>{versionLabel(version, (id) => host.authorName(id))}</span>
              <small>{relativeTime.day(version.at)}</small>
            </div>
            {version.content != null && version.content !== detail.content
              ? <IconButton title="Bring back this version" icon="arrow.uturn.backward" disabled={memory.busy} onClick={() => void change({ version: version.id })} />
              : null}
          </div>)}
        </CardSection>
      </> : <CardSection><p className="memory-muted">Loading…</p></CardSection>}
    </CardForm>
    <Dialog open={confirmDelete} title={`Delete ${target.name ?? 'this note'}?`} message="Its versions stay, so you can bring it back."
      actions={[{ title: 'Delete', destructive: true, action: () => void change({}) }]} onClose={() => setConfirmDelete(false)} />
  </div>
}
