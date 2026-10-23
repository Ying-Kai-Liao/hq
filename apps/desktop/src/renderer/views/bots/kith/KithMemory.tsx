import { useEffect, useMemo } from 'react'
import { SearchField, Spinner } from '../../../components/Controls'
import { useModel } from '../../../lib/observable'
import { useStoreRef } from '../../../store/context'
import { KithMemorySearch } from '../../../store/kith-info-store'
import './kith.css'

/** Search over the agent's memory files (`kithMemorySearch`) for the "This agent" section; a hit opens its file in the editor. */
export function AgentMemorySearch({ botId, open, children }: { botId: string; open: (path: string) => void; children: React.ReactNode }) {
  const host = useStoreRef()
  const search = useModel(useMemo(() => new KithMemorySearch(botId, () => host.ready()), [botId, host]))
  useEffect(() => () => search.dispose(), [search])
  return <>
    <SearchField value={search.query} onChange={(q) => search.setQuery(q)} prompt="Search this agent's memory" />
    {search.query.trim() !== '' ? <Hits search={search} open={open} /> : children}
  </>
}

function Hits({ search, open }: { search: KithMemorySearch; open: (path: string) => void }) {
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
          ? <button key={`${hit.path}:${hit.line}:${i}`} className="kith-file press" onClick={() => open(hit.path)}>{body}</button>
          : <div key={`${hit.path}:${hit.line}:${i}`} className="kith-file disabled" aria-disabled="true" title="This file is outside the agent's memory folder">{body}</div>
      })}
    </div>
  )
}
