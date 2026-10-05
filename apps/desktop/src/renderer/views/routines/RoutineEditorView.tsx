import { useEffect, useRef, useState } from 'react'
import { Button, ChoicePicker, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { emptyDraft, errorText, sameDraft, type Routine, type RoutineScheduleDraft, type RoutineSchedulePreview } from './routine'
import { Field, RoutineWebhookPanel } from './RoutineWebhookPanel'
import './routines.css'

const caption = { ...font('caption'), paddingLeft: 4, lineHeight: 1.4 } as const

export function RoutineEditorView({ botId, routine, saved }: {
  botId: string
  routine: Routine | null
  /** Called after a save (the routine) or a delete (null). */
  saved: (routine: Routine | null) => void
}) {
  const store = useStore()
  const [name, setName] = useState(routine?.name ?? '')
  const [instruction, setInstruction] = useState(routine?.instruction ?? '')
  const [schedule, setSchedule] = useState<RoutineScheduleDraft>(emptyDraft)
  const [timeout, setTimeoutText] = useState(String(routine?.timeoutSeconds ?? 3600))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState<RoutineSchedulePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [checkedSchedule, setCheckedSchedule] = useState<RoutineScheduleDraft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [started, setStarted] = useState(false)
  const latest = useRef(schedule)
  latest.current = schedule

  // Anything the bot set up (a one-off time, an interval, events, several triggers) stays as it is until replaced.
  const keepsOriginal = routine ? (routine.triggers.length === 1 ? !['cron', 'webhook'].includes(routine.triggers[0]!.type) : routine.triggers.length > 0) : false
  const options = [
    ...(routine && keepsOriginal ? [{ id: 'keep', label: routine.triggerDescriptions.join(' · ') }] : []),
    { id: 'cron', label: 'Schedule' },
    { id: 'webhook', label: 'Webhook' },
  ]
  const canSave = !!name.trim() && !!instruction.trim() && !store.isOffline && !busy && loaded && sameDraft(checkedSchedule, schedule) && previewError === null

  const loadSchedule = async () => {
    try {
      const client = await store.ready()
      const result = await client.call<RoutineSchedulePreview>('routineSchedule', {
        triggers: routine?.triggers ?? [],
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      const draft = { ...result.draft, calendarStyle: 'custom' }
      if (!['cron', 'webhook'].includes(draft.kind)) draft.kind = 'keep'
      setSchedule(draft)
      setPreview(result)
      setCheckedSchedule(result.draft)
      setLoaded(true)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const checkSchedule = async () => {
    const requested = latest.current
    setPreview(null)
    setPreviewError(null)
    setCheckedSchedule(null)
    try {
      const result = await (await store.ready()).call<RoutineSchedulePreview>('routineSchedule', { draft: requested })
      if (latest.current !== requested) return
      setPreview(result)
      setCheckedSchedule(requested)
    } catch (e) {
      if (latest.current !== requested) return
      setPreviewError(errorText(e))
    }
  }

  useEffect(() => {
    void loadSchedule()
  }, [])

  // The host checks each edit to the schedule, after a short pause in typing.
  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => void checkSchedule(), 300)
    return () => clearTimeout(timer)
  }, [schedule])

  const save = async () => {
    if (!canSave) return
    // Saving ends editing (a new webhook routine stays open on its URL and key).
    ;(document.activeElement as HTMLElement | null)?.blur()
    setBusy(true)
    setError(null)
    try {
      const client = await store.ready()
      const result = await client.call<{ routine: Routine }>('saveRoutine', {
        botId,
        id: routine?.id ?? null,
        name,
        instruction,
        schedule,
        timeoutSeconds: timeout,
      })
      saved(result.routine)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  // ⌘S saves.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const update = (change: Partial<RoutineScheduleDraft>) => setSchedule((s) => ({ ...s, ...change }))
  const shownPreview = sameDraft(checkedSchedule, schedule) ? preview : null

  const triggerFields = () => {
    switch (schedule.kind) {
      case 'cron':
        return (
          <div className="routine-cron" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="routine-cron-fields">
              <Field label="Cron">
                <input
                  className="routine-input"
                  style={font('body', undefined, 'monospaced')}
                  value={schedule.expression}
                  placeholder="0 9 * * 1-5"
                  spellCheck={false}
                  autoCorrect="off"
                  onChange={(e) => update({ expression: e.target.value })}
                />
              </Field>
              <Field label="Time zone">
                <input className="routine-input" value={schedule.zone} placeholder="Asia/Taipei" spellCheck={false} autoCorrect="off" onChange={(e) => update({ zone: e.target.value })} />
              </Field>
            </div>
            <div style={{ paddingLeft: 4 }}>
              {previewError ? (
                <span style={{ ...font('caption'), color: 'var(--danger)', lineHeight: 1.4 }}>{previewError}</span>
              ) : shownPreview ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={font('caption', 'medium')}>{shownPreview.summary}</span>
                  {shownPreview.nextRunAt ? (
                    <span style={{ ...font('caption'), color: 'var(--secondary)' }}>
                      Next {new Date(shownPreview.nextRunAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  ) : null}
                  {shownPreview.warning ? <span style={{ ...font('caption'), color: 'var(--secondary)' }}>{shownPreview.warning}</span> : null}
                </div>
              ) : (
                <span style={{ ...font('caption', undefined, 'monospaced'), color: 'var(--tertiary)', whiteSpace: 'pre' }}>minute  hour  day  month  weekday</span>
              )}
            </div>
          </div>
        )
      case 'webhook':
        return routine && routine.triggers.some((t) => t.type === 'webhook' || t.type === 'event') ? (
          <RoutineWebhookPanel botId={botId} routineId={routine.id} />
        ) : (
          <span style={{ ...caption, color: 'var(--secondary)' }}>Runs each time something is posted to its URL. Save to get the URL and key.</span>
        )
      default:
        return <span style={{ ...caption, color: 'var(--secondary)' }}>Set up by the bot. Pick Schedule or Webhook to replace it.</span>
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 700, minHeight: 0, background: 'var(--background)', color: 'var(--text)', ...font(13) }}>
      <ModalHeader title={routine ? 'Edit routine' : 'Set up a routine'} />
      {/* The card fits the form; it scrolls only when taller than the window allows. */}
      <fieldset className="routine-form" disabled={busy || !loaded} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Name">
              <input className="routine-input" value={name} placeholder="e.g. Morning summary" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Instruction">
              <textarea className="routine-input" value={instruction} placeholder="Describe what this bot should do each time it runs." onChange={(e) => setInstruction(e.target.value)} />
            </Field>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="When to run">
              <ChoicePicker selection={schedule.kind} options={options} onChange={(kind) => update({ kind })} fits />
            </Field>
            {loaded ? (
              triggerFields()
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--secondary)' }}>
                <Icon name="clock" size={12} />
                Loading schedule…
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              className="press"
              aria-expanded={advanced}
              onClick={() => setAdvanced((a) => !a)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 4, ...font('compactSecondary'), color: 'var(--secondary)', width: '100%' }}
            >
              Run settings
              <span style={{ display: 'flex', transform: `rotate(${advanced ? 180 : 0}deg)`, transition: 'transform var(--layout)' }}>
                <Icon name="chevron.down" size={10} weight="semibold" />
              </span>
              <span style={{ flex: 1 }} />
              {!advanced ? <span style={{ color: 'var(--tertiary)' }}>Timeout {timeout}s</span> : null}
            </button>
            {advanced ? (
              <div className="routine-fade" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Timeout (seconds)">
                  <input className="routine-input" value={timeout} placeholder="3600" onChange={(e) => setTimeoutText(e.target.value)} />
                </Field>
                <span style={{ ...caption, color: 'var(--secondary)' }}>A run is stopped after this long. 1 second to 24 hours.</span>
              </div>
            ) : null}
          </div>
        </div>
      </fieldset>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 20, flex: 'none' }}>
        {previewError !== null ? (
          <button className="press" style={{ alignSelf: 'flex-start' }} disabled={store.isOffline} onClick={() => void checkSchedule()}>
            Check schedule again
          </button>
        ) : null}
        {!loaded && error !== null ? (
          <button className="press" style={{ alignSelf: 'flex-start' }} onClick={() => void loadSchedule()}>
            Retry loading schedule
          </button>
        ) : null}
        {schedule.kind !== 'cron' && previewError ? <span style={{ ...font('caption'), color: 'var(--danger)' }}>{previewError}</span> : null}
        {error ? (
          <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start', ...font('callout'), color: 'var(--danger)', userSelect: 'text' }}>
            <Icon name="exclamationmark.circle" size={12} style={{ marginTop: 1 }} />
            {error}
          </span>
        ) : null}
        {store.isOffline ? (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', ...font('caption'), color: 'var(--danger)' }}>
            <Icon name="wifi.slash" size={10} />
            Connect to this computer to save your routine.
          </span>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {routine ? (
            <>
              <IconButton title="Delete routine" icon="trash" onClick={() => setConfirmDelete(true)} />
              <IconButton
                title={started ? 'Started' : 'Test run'}
                icon={started ? 'checkmark' : 'play.circle'}
                disabled={started || store.isOffline}
                onClick={async () => {
                  try {
                    await (await store.ready()).call('runRoutine', { botId, id: routine.id })
                    setStarted(true)
                  } catch (e) {
                    setError(errorText(e))
                  }
                }}
              />
            </>
          ) : null}
          <span style={{ flex: 1 }} />
          <Button disabled={!canSave} onClick={() => void save()} title="Save (⌘S)">
            {busy ? <Spinner size={12} /> : null}
            {busy ? 'Saving…' : routine ? 'Save changes' : 'Create routine'}
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        title="Delete routine?"
        message="This deletes the routine and stops its future runs. This can't be undone."
        actions={[
          {
            title: 'Delete routine',
            destructive: true,
            action: async () => {
              if (!routine) return
              try {
                await (await store.ready()).call('deleteRoutine', { botId, id: routine.id })
                saved(null)
              } catch (e) {
                setError(errorText(e))
              }
            },
          },
        ]}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  )
}
