import { useEffect, useState } from 'react'
import { chipOf, isProjectId, lastComponent, needsConfirm, pickerSections, projectAt, projectIdFromName, selectionOfRecent, type PlaceFolder, type PlaceSelection, type ProjectInfo, type RecentFolder, type StartingFolder } from '@shared/place-folders'
import { CardSection, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader, Sheet, SheetPage } from '../../components/Overlay'
import { HStack, IconSlot } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useStore } from '../../store/context'
import { errorText } from './drafts'
import { FolderPicker } from './BotEditorView'
import './place-folder.css'

/**
 * Where a chat, thread or task works: an hq project, a recent folder, or any folder. `onPick` does the
 * work (the host may refuse it); its error shows here and the picker stays open.
 */
export function PlaceFolderSheet({ open, onClose, current, onPick }: {
  open: boolean
  onClose: () => void
  /** The folder the place works in now; null when unknown. */
  current: PlaceFolder | null
  onPick: (selection: PlaceSelection) => Promise<void> | void
}) {
  return (
    <Sheet open={open} onClose={onClose} width={460} height={560} dismissOnDim>
      <PlaceFolderPicker current={current} onPick={onPick} onClose={onClose} />
    </Sheet>
  )
}

type Step = { kind: 'list' } | { kind: 'browse' } | { kind: 'register'; path: string }

function PlaceFolderPicker({ current, onPick, onClose }: { current: PlaceFolder | null; onPick: (s: PlaceSelection) => Promise<void> | void; onClose: () => void }) {
  const store = useStore()
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [hqError, setHqError] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentFolder[]>([])
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    store.projects().then((r) => {
      if (!live) return
      setProjects(r.projects)
      setHqError(r.error ?? null)
    }).catch((e: unknown) => {
      // A host without place folders knows no `projects`: folders still work.
      if (!live) return
      setProjects([])
      setHqError(errorText(e))
    })
    store.recentFolders().then((r) => live && setRecent(r)).catch(() => {})
    return () => {
      live = false
    }
  }, [store])

  const commit = async (selection: PlaceSelection) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onPick(selection)
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
      setStep({ kind: 'list' })
    }
  }

  // A folder that is not an hq project may be registered as one first; skippable.
  const folderChosen = (path: string, listed: string | null = null) => {
    const project = projectAt(path, projects ?? [], listed)
    if (project) void commit({ project })
    else if (hqError) void commit({ folder: path })
    else setStep({ kind: 'register', path })
  }

  const choose = async () => {
    if (store.isLoopback) {
      const path = await window.codync.app.pickFolder(store.hello?.home ?? null)
      if (path) folderChosen(path)
    } else {
      // The system dialog shows this Mac's folders, not the other computer's.
      setStep({ kind: 'browse' })
    }
  }

  if (step.kind === 'browse') {
    return <FolderPicker start={store.hello?.home ?? null} onPick={(path) => folderChosen(path)} />
  }
  if (step.kind === 'register') {
    return <RegisterStep path={step.path} onUse={() => void commit({ folder: step.path })} onRegistered={(id) => void commit({ project: id })} onBack={() => setStep({ kind: 'list' })} busy={busy} error={error} />
  }

  const sections = pickerSections(projects ?? [], recent, current)
  return (
    <SheetPage>
      <ModalHeader title="Working folder" subtitle="Changing it starts a fresh session here." trailing={busy ? <Spinner /> : null} />
      <div className="place-picker-body">
        {error ? <Text tone="danger" className="place-picker-error">{error}</Text> : null}
        {current && !current.inherited ? (
          <CardSection>
            <button className="press place-row" onClick={() => void commit({ clear: true })} disabled={busy}>
              <IconSlot width={20}><Icon name="arrow.counterclockwise" size={12} color="var(--secondary)" /></IconSlot>
              <Text tone="text" grow truncate>Use default</Text>
            </button>
          </CardSection>
        ) : null}
        <CardSection title="hq projects" footer={hqError ? <Text tone="secondary" size="footnote">{hqError}</Text> : null}>
          {projects === null ? (
            <HStack justify="center"><Spinner size={16} /></HStack>
          ) : sections.projects.length ? (
            sections.projects.map((p) => (
              <button key={p.id} className={`press place-row ${p.disabled ? 'dim' : ''}`} disabled={busy || p.disabled} onClick={() => void commit({ project: p.id })} title={p.disabled ? 'No folder for this project on this computer' : (p.path ?? p.id)}>
                <IconSlot width={20}><Icon name="arrow.triangle.branch" size={12} color="var(--accent)" /></IconSlot>
                <span className="place-row-text">
                  <Text tone="text" truncate>{p.id}</Text>
                  <Text tone="tertiary" size="footnote" truncate>{p.path ?? 'No folder on this computer'}</Text>
                </span>
                {p.current ? <Icon name="checkmark" size={12} color="var(--accent)" /> : null}
              </button>
            ))
          ) : (
            <Text tone="secondary" size="footnote">No hq projects.</Text>
          )}
        </CardSection>
        {sections.recent.length ? (
          <CardSection title="Recent folders">
            {sections.recent.map((r) => (
              <button key={r.path} className="press place-row" disabled={busy} onClick={() => void commit(selectionOfRecent(r))} title={r.path}>
                <IconSlot width={20}><Icon name={r.project ? 'arrow.triangle.branch' : 'folder'} size={12} color={r.project ? 'var(--accent)' : 'var(--secondary)'} /></IconSlot>
                <span className="place-row-text">
                  <Text tone="text" truncate>{r.project ?? r.name}</Text>
                  <Text tone="tertiary" size="footnote" truncate>{r.path}</Text>
                </span>
                {r.current ? <Icon name="checkmark" size={12} color="var(--accent)" /> : null}
              </button>
            ))}
          </CardSection>
        ) : null}
        <CardSection>
          <button className="press place-row" onClick={() => void choose()} disabled={busy}>
            <IconSlot width={20}><Icon name="folder" size={12} color="var(--secondary)" /></IconSlot>
            <Text tone="text" grow>Choose folder…</Text>
            <Icon name="chevron.right" size={10} weight="semibold" color="var(--tertiary)" />
          </button>
        </CardSection>
      </div>
    </SheetPage>
  )
}

function RegisterStep({ path, onUse, onRegistered, onBack, busy, error }: {
  path: string
  onUse: () => void
  onRegistered: (id: string) => void
  onBack: () => void
  busy: boolean
  error: string | null
}) {
  const store = useStore()
  const [id, setId] = useState(() => projectIdFromName(lastComponent(path)))
  const [registering, setRegistering] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const valid = isProjectId(id)
  const register = () => {
    if (!valid || registering) return
    setRegistering(true)
    setFailure(null)
    store
      .registerProject(id, path)
      .then(() => onRegistered(id))
      // hq's own message, for example when the id exists.
      .catch((e: unknown) => setFailure(errorText(e)))
      .finally(() => setRegistering(false))
  }
  return (
    <SheetPage>
      <HStack>
        <HStack align="stretch" className="folder-back">
          <IconButton title="Back" icon="chevron.left" onClick={onBack} />
        </HStack>
        <div className="folder-title"><ModalHeader title={lastComponent(path)} subtitle={path} /></div>
      </HStack>
      <div className="place-picker-body">
        <CardSection title="Register as hq project" footer="A registered project gives the agent its CLAUDE.md, codebase notes and memory.">
          <input
            className="field-box place-id-field"
            value={id}
            aria-label="Project id"
            placeholder="project-id"
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter') register()
            }}
          />
        </CardSection>
        {failure || error ? <Text tone="danger" className="place-picker-error">{failure ?? error}</Text> : null}
        <CardSection>
          <button className="press place-row" onClick={register} disabled={!valid || registering || busy}>
            <IconSlot width={20}>{registering ? <Spinner size={14} /> : <Icon name="plus" size={12} color="var(--accent)" />}</IconSlot>
            <Text grow tone="accent">Register and use</Text>
          </button>
          <button className="press place-row" onClick={onUse} disabled={registering || busy}>
            <IconSlot width={20}><Icon name="folder" size={12} color="var(--secondary)" /></IconSlot>
            <Text grow tone="text">Use folder only</Text>
          </button>
        </CardSection>
      </div>
    </SheetPage>
  )
}

/** The place's folder as a small button: kind icon, name, "inherited" when it follows a default. */
export function PlaceFolderChip({ folder, onClick, className }: { folder: PlaceFolder; onClick: () => void; className?: string }) {
  const chip = chipOf(folder)
  return (
    <button
      className={`press place-chip ${className ?? ''}`}
      onClick={onClick}
      title={folder.missing ? `${chip.title} is missing on this computer; the agent works in the bot’s folder` : chip.title}
      aria-label={`Working folder: ${chip.label}${folder.inherited ? ', inherited' : ''}. Change`}
    >
      <Icon name={chip.icon} size={11} color="var(--secondary)" />
      <Text size="footnote" tone="secondary" truncate>{chip.label}</Text>
      {folder.inherited ? <Text size="footnote" tone="tertiary">inherited</Text> : null}
      {folder.missing ? <Icon name="exclamationmark.triangle" size={11} color="var(--warning)" /> : null}
    </button>
  )
}

/**
 * The header control of a live place (a bot's chat, or the thread on `threadId`): the chip, the
 * picker, and the host call. A place with messages asks before the fresh session.
 */
export function PlaceFolderControl({ botId, threadId = null, folder, messages, className }: {
  botId: string
  threadId?: string | null
  folder: PlaceFolder | null
  messages: number
  className?: string
}) {
  const store = useStore()
  const [confirming, setConfirming] = useState(false)
  const [picking, setPicking] = useState(false)
  // Hidden for a group and for a host without place folders.
  if (!folder) return null
  return (
    <>
      <PlaceFolderChip folder={folder} className={className} onClick={() => (needsConfirm(messages) ? setConfirming(true) : setPicking(true))} />
      <Dialog
        open={confirming}
        title="Change the working folder?"
        message="This place starts a fresh session in the new folder. Its earlier messages stay, and a running turn stops."
        actions={[{ title: 'Choose folder…', action: () => setPicking(true) }]}
        onClose={() => setConfirming(false)}
      />
      <PlaceFolderSheet
        open={picking}
        onClose={() => setPicking(false)}
        current={folder}
        onPick={async (selection) => { await store.setPlaceFolder(botId, selection, threadId) }}
      />
    </>
  )
}

/** A folder picked before the place exists (a new chat or task): sent along with its first message. */
export interface StartingPick {
  start: StartingFolder
  name: string
}

/** The chip for a place that does not exist yet; shows the inherited folder until one is picked. */
export function StartingFolderChip({ inherited, value, onChange, className }: {
  inherited: PlaceFolder | null
  value: StartingPick | null
  onChange: (pick: StartingPick | null) => void
  className?: string
}) {
  const [picking, setPicking] = useState(false)
  const shown: PlaceFolder | null = value
    ? { kind: 'project' in value.start ? 'project' : 'folder', path: null, name: value.name, inherited: false }
    : inherited
  // A host without place folders sends none, and then there is nothing to pick.
  if (!shown) return null
  return (
    <>
      <PlaceFolderChip folder={shown} className={className} onClick={() => setPicking(true)} />
      <PlaceFolderSheet
        open={picking}
        onClose={() => setPicking(false)}
        current={shown}
        onPick={(selection) => {
          if ('clear' in selection) return onChange(null)
          onChange({ start: selection, name: 'project' in selection ? selection.project : lastComponent(selection.folder) })
        }}
      />
    </>
  )
}
