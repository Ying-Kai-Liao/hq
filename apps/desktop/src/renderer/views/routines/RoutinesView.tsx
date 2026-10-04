import { Fragment, useEffect, useRef, useState } from 'react'
import { Hairline, IconButton, Switch } from '../../components/Controls'
import { Sheet } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { errorText, isActiveRun, type Routine, type RoutineListing, type RoutineRun } from './routine'
import { RoutineEditorView } from './RoutineEditorView'

/** The open editor: on a routine, or (`routineId` null) setting up a new one. `id` is one per opening. */
interface EditorTarget {
  id: string
  routineId: string | null
}

function runLabel(run: RoutineRun) {
  switch (run.status) {
    case 'pending':
      return 'Queued'
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'recovering':
      return 'Resuming after restart'
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return 'Interrupted'
    default:
      return run.status.charAt(0).toUpperCase() + run.status.slice(1)
  }
}

/** The routine list in the details panel (and the routines sheet); a row opens its editor. */
export function RoutinesView({ botId, initialId, onClose }: { botId: string; initialId: string | null; onClose?: () => void }) {
  const store = useStore()
  const [routines, setRoutines] = useState<Routine[]>([])
  const [runs, setRuns] = useState<RoutineRun[]>([])
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const current = useRef(botId)
  current.current = botId

  const open = (routineId: string | null) => setEditing({ id: crypto.randomUUID(), routineId })

  const load = async () => {
    const asked = botId
    try {
      const result = await (await store.ready()).call<RoutineListing>('routines', { botId: asked })
      if (current.current !== asked) return
      setRoutines(result.routines)
      setRuns(result.runs)
      setLoaded(true)
      setLoadError(null)
    } catch (e) {
      if (current.current === asked) setLoadError(errorText(e))
    }
  }

  useEffect(() => {
    if (initialId) open(initialId)
  }, [initialId])

  useEffect(() => {
    setRoutines([])
    setRuns([])
    setLoaded(false)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await load()
      if (!stopped) timer = setTimeout(tick, 3000)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [botId])

  const action = async (method: string, routine: Routine, enabled?: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await (await store.ready()).call(method, { botId, id: routine.id, enabled: enabled ?? null })
      setError(null)
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  /** The row's second line: what's happening now, else when it runs. */
  const summary = (routine: Routine) => {
    const active = runs.find((r) => r.routineId === routine.id && isActiveRun(r))
    if (active) return runLabel(active)
    if (routine.lastError) return 'Schedule needs attention'
    const last = runs.find((r) => r.routineId === routine.id)
    if (last && ['failed', 'interrupted'].includes(last.status)) return `Last run ${runLabel(last).toLowerCase()}`
    return routine.triggerDescriptions.join(' · ')
  }

  const onSaved = (target: EditorTarget, saved: Routine | null) => {
    if (saved) setRoutines((list) => (list.some((r) => r.id === saved.id) ? list.map((r) => (r.id === saved.id ? saved : r)) : [...list, saved]))
    // A new webhook routine stays open: its URL and key exist only now.
    if (target.routineId === null && saved && saved.triggers.some((t) => t.type === 'webhook')) {
      setEditing({ id: target.id, routineId: saved.id })
    } else {
      setEditing(null)
    }
    void load()
  }

  const editingRoutine = routines.find((r) => r.id === editing?.routineId) ?? null
  const surface = { background: 'var(--surface)', borderRadius: 16 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: onClose ? 16 : 10, color: 'var(--text)', ...font(13) }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ ...font(13, 'semibold'), paddingLeft: 2 }}>Routines</span>
        <span style={{ flex: 1 }} />
        <IconButton title="Ask the bot for a routine" icon="text.bubble" disabled={store.isOffline} onClick={() => {
          store.setRoutineDraft(botId, 'I want a routine that ')
          onClose?.()
        }} />
        <IconButton title="Set up a routine" icon="plus" disabled={store.isOffline} onClick={() => open(null)} />
        {onClose ? <IconButton title="Close routines" icon="xmark" onClick={onClose} /> : null}
      </div>
      {loadError ? <span style={{ ...font('caption'), color: 'var(--danger)' }}>{loadError}</span> : null}
      {error ? <span style={{ ...font('caption'), color: 'var(--danger)', userSelect: 'text' }}>{error}</span> : null}
      {routines.length === 0 ? (
        <div style={{ ...surface, ...font(12), lineHeight: 1.45, color: 'var(--secondary)', padding: 14 }}>
          {loaded ? 'No routines yet. Ask the bot for one, or set it up yourself with +.' : 'Loading routines…'}
        </div>
      ) : (
        <div style={{ ...surface, padding: '0 14px' }}>
          {routines.map((routine, i) => (
            <Fragment key={routine.id}>
              {i > 0 ? <Hairline /> : null}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="routine-row" onClick={() => open(routine.id)}>
                  <span style={{ color: 'var(--text)' }}>{routine.name}</span>
                  <span style={{ ...font('caption'), color: routine.lastError ? 'var(--danger)' : 'var(--secondary)' }}>{summary(routine)}</span>
                </button>
                <span aria-label={routine.name} style={{ display: 'flex' }}>
                  <Switch on={routine.enabled} disabled={busy || store.isOffline} onChange={(on) => void action('setRoutineEnabled', routine, on)} />
                </span>
              </div>
            </Fragment>
          ))}
        </div>
      )}
      {/* A routine opened before the list arrived waits for it. */}
      <Sheet open={editing !== null && (editing.routineId === null || editingRoutine !== null)} onClose={() => setEditing(null)} width={540}>
        {editing ? (
          <RoutineEditorView
            key={editing.id}
            botId={botId}
            routine={editingRoutine}
            saved={(saved) => onSaved(editing, saved)}
          />
        ) : null}
      </Sheet>
    </div>
  )
}
