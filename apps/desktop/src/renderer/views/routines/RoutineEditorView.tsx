import { useEffect, useRef, useState } from 'react'
import { Button, ChoicePicker, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader } from '../../components/Overlay'
import { HStack, Spacer, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useStore } from '../../store/context'
import { emptyDraft, errorText, sameDraft, type Routine, type RoutineScheduleDraft, type RoutineSchedulePreview } from './routine'
import { Field } from '../bots/parts'
import { RoutineWebhookPanel } from './RoutineWebhookPanel'
import './routines.css'

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
          <VStack gap={8} className="routine-cron">
            <div className="routine-cron-fields">
              <Field label="Cron">
                <input
                  className="routine-input routine-cron-input"
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
            <div className="routine-cron-preview">
              {previewError ? (
                <Text size="caption" tone="danger" className="routine-cron-error">{previewError}</Text>
              ) : shownPreview ? (
                <VStack gap={2}>
                  <Text size="caption" weight="medium">{shownPreview.summary}</Text>
                  {shownPreview.nextRunAt ? (
                    <Text size="caption" tone="secondary">
                      Next {new Date(shownPreview.nextRunAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </Text>
                  ) : null}
                  {shownPreview.warning ? <Text size="caption" tone="secondary">{shownPreview.warning}</Text> : null}
                </VStack>
              ) : (
                <Text size="caption" mono tone="tertiary" className="routine-cron-hint">minute  hour  day  month  weekday</Text>
              )}
            </div>
          </VStack>
        )
      case 'webhook':
        return routine && routine.triggers.some((t) => t.type === 'webhook' || t.type === 'event') ? (
          <RoutineWebhookPanel botId={botId} routineId={routine.id} />
        ) : (
          <Text size="caption" tone="secondary" className="routine-caption">Runs each time something is posted to its URL. Save to get the URL and key.</Text>
        )
      default:
        return <Text size="caption" tone="secondary" className="routine-caption">Set up by the bot. Pick Schedule or Webhook to replace it.</Text>
    }
  }

  return (
    <VStack className="routine-editor">
      <ModalHeader title={routine ? 'Edit routine' : 'Set up a routine'} />
      {/* The card fits the form; it scrolls only when taller than the window allows. */}
      <fieldset className="routine-form" disabled={busy || !loaded}>
        <VStack gap={24} className="routine-form-body">
          <VStack gap={14}>
            <Field label="Name">
              <input className="routine-input" value={name} placeholder="e.g. Morning summary" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Instruction">
              <textarea className="routine-input" value={instruction} placeholder="Describe what this bot should do each time it runs." onChange={(e) => setInstruction(e.target.value)} />
            </Field>
          </VStack>
          <VStack gap={14}>
            <Field label="When to run">
              <ChoicePicker selection={schedule.kind} options={options} onChange={(kind) => update({ kind })} fits />
            </Field>
            {loaded ? (
              triggerFields()
            ) : (
              <HStack as="span" gap={6} className="routine-loading">
                <Icon name="clock" size={12} />
                Loading schedule…
              </HStack>
            )}
          </VStack>
          <VStack gap={12}>
            <button className="press routine-advanced" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
              Run settings
              <span className={`routine-chevron ${advanced ? 'open' : ''}`}>
                <Icon name="chevron.down" size={10} weight="semibold" />
              </span>
              <Spacer />
              {!advanced ? <Text tone="tertiary">Timeout {timeout}s</Text> : null}
            </button>
            {advanced ? (
              <VStack gap={12} className="routine-fade">
                <Field label="Timeout (seconds)">
                  <input className="routine-input" value={timeout} placeholder="3600" onChange={(e) => setTimeoutText(e.target.value)} />
                </Field>
                <Text size="caption" tone="secondary" className="routine-caption">A run is stopped after this long. 1 second to 24 hours.</Text>
              </VStack>
            ) : null}
          </VStack>
        </VStack>
      </fieldset>

      <VStack gap={12} className="routine-editor-footer">
        {previewError !== null ? (
          <button className="press routine-retry" disabled={store.isOffline} onClick={() => void checkSchedule()}>
            Check schedule again
          </button>
        ) : null}
        {!loaded && error !== null ? (
          <button className="press routine-retry" onClick={() => void loadSchedule()}>
            Retry loading schedule
          </button>
        ) : null}
        {schedule.kind !== 'cron' && previewError ? <Text size="caption" tone="danger">{previewError}</Text> : null}
        {error ? (
          <HStack as="span" gap={6} align="flex-start" className="routine-error">
            <Icon name="exclamationmark.circle" size={12} className="routine-error-icon" />
            {error}
          </HStack>
        ) : null}
        {store.isOffline ? (
          <HStack as="span" gap={6} className="routine-offline">
            <Icon name="wifi.slash" size={10} />
            Connect to this computer to save your routine.
          </HStack>
        ) : null}
        <HStack gap={16}>
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
          <Spacer />
          <Button disabled={!canSave} onClick={() => void save()} title="Save (⌘S)">
            {busy ? <Spinner size={12} /> : null}
            {busy ? 'Saving…' : routine ? 'Save changes' : 'Create routine'}
          </Button>
        </HStack>
      </VStack>

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
    </VStack>
  )
}
