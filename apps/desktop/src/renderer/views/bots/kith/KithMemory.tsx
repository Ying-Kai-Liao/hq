import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, lineOffset, sortMemoryFiles } from '@shared/kith-info'
import { SearchField, Spinner, TabChoice } from '../../../components/Controls'
import { Icon } from '../../../components/Icon'
import { ModalHeader, Sheet } from '../../../components/Overlay'
import { useModel } from '../../../lib/observable'
import { useStoreRef } from '../../../store/context'
import { KithMemorySearch, KithMemoryViewer, type KithInfoStore } from '../../../store/kith-info-store'
import { relativeTime } from '../../thread/chat-items'
import { MarkdownText } from '../../thread/Markdown'
import './kith.css'

/** "Agent memory": the agent's own files, searchable and readable, never editable here. Above Kith's own memory cards. */
export function KithMemory({ botId, kith }: { botId: string; kith: KithInfoStore }) {
  const host = useStoreRef()
  const search = useModel(useMemo(() => new KithMemorySearch(botId, () => host.ready()), [botId, host]))
  const viewer = useModel(useMemo(() => new KithMemoryViewer(botId, () => host.ready()), [botId, host]))
  useEffect(() => () => search.dispose(), [search])
  if (kith.unsupported) return null

  const memory = kith.info?.memory
  const files = memory ? sortMemoryFiles(memory.files) : []
  const searching = search.query.trim() !== ''
  return (
    <section className="details-section kith-memory">
      <span className="details-section-title">Agent memory</span>
      <SearchField value={search.query} onChange={(q) => search.setQuery(q)} prompt="Search this agent's memory" />
      <div className="outlined-card kith-card">
        {searching ? <Hits search={search} open={(path, line) => void viewer.open(path, line)} />
          : !kith.info ? <p className="kith-muted" role="status">{kith.error ? `Kith details unavailable: ${kith.error}` : kith.loaded ? 'No kith details for this bot' : 'Loading memory…'}</p>
          : kith.info.errors.memory !== undefined ? <p className="kith-muted kith-failed">Couldn't read the memory</p>
          : !files.length ? <p className="kith-muted">No memory files yet</p>
          : <>
            {files.map((f) => (
              <button key={f.path} className="kith-file press" onClick={() => void viewer.open(f.path)}>
                <span className="kith-ellipsis"><Icon name="doc.text" size={11} /> {f.path}</span>
                <small className="kith-muted">{formatBytes(f.bytes)}{f.modified !== null ? ` · ${relativeTime.day(f.modified)}` : ''}</small>
              </button>
            ))}
            <small className="kith-muted">{files.length} {files.length === 1 ? 'file' : 'files'} · {formatBytes(memory!.totalBytes)}</small>
          </>}
      </div>
      <Sheet open={viewer.path !== null} onClose={() => viewer.close()} width={640}>
        <Viewer viewer={viewer} />
      </Sheet>
    </section>
  )
}

function Hits({ search, open }: { search: KithMemorySearch; open: (path: string, line: number | null) => void }) {
  if (search.error && !search.hits.length) return <p className="kith-muted kith-failed" role="alert">{search.error}</p>
  if (search.searching && !search.hits.length) return <p className="kith-muted kith-loading" role="status"><Spinner size={12} /> Searching…</p>
  if (!search.hits.length) return <p className="kith-muted">Nothing found</p>
  return (
    <div className={search.searching ? 'kith-stale' : undefined}>
      {search.searching ? <p className="kith-muted kith-loading" role="status"><Spinner size={12} /> Searching…</p> : null}
      {search.hits.map((hit, i) => {
        const where = `${hit.path}${hit.line !== null ? `:${hit.line}` : ''}`
        const body = (
          <>
            <span className="kith-ellipsis"><strong>{where}</strong>{!hit.openable && hit.agent ? <span className="kith-muted"> · {hit.agent}</span> : null}</span>
            <small className="kith-muted kith-snippet">{hit.snippet}</small>
          </>
        )
        return hit.openable
          ? <button key={`${hit.path}:${hit.line}:${i}`} className="kith-file press" onClick={() => open(hit.path, hit.line)}>{body}</button>
          : <div key={`${hit.path}:${hit.line}:${i}`} className="kith-file disabled" aria-disabled="true" title="This file is outside the agent's memory folder">{body}</div>
      })}
    </div>
  )
}

/** A file, rendered as markdown with a switch to the raw text; opens near a hit's line. */
function Viewer({ viewer }: { viewer: KithMemoryViewer }) {
  const [raw, setRaw] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const file = viewer.file
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !file || viewer.line === null) return
    const lines = file.text.split('\n').length
    el.scrollTop = (lineOffset(viewer.line, lines) / lines) * el.scrollHeight
  }, [file, viewer.line, raw])
  return (
    <div className="memory-file-sheet">
      <ModalHeader
        title={viewer.path ?? ''}
        trailing={<TabChoice label="View" selection={raw ? 'raw' : 'read'} options={[{ id: 'read', label: 'Read' }, { id: 'raw', label: 'Raw' }]} onChange={(v) => setRaw(v === 'raw')} />}
      />
      <div className="kith-viewer selectable" ref={scroller}>
        {viewer.loading ? <p className="kith-muted kith-loading" role="status"><Spinner size={12} /> Loading…</p> : null}
        {viewer.error ? <p role="alert" className="memory-error">{viewer.error}</p> : null}
        {file ? <>
          {file.truncated ? <p className="kith-muted kith-truncated">Showing the first 512 KB of {formatBytes(file.bytes)}</p> : null}
          {raw ? <pre className="memory-file-text">{file.text}</pre> : <MarkdownText text={file.text} />}
        </> : null}
      </div>
    </div>
  )
}
