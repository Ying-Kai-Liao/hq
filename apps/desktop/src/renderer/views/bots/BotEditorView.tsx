import { useCallback, useEffect, useRef, useState } from 'react'
import { fastModeRefusal, fastModeShown } from '@shared/fast-mode'
import type { ProjectInfo } from '@shared/place-folders'
import { draftOf, type BotDraft, type DirListing } from '@shared/models'
import { AgentIcon } from '../../components/AgentIcon'
import { avatarImage, CREW, SPARES, type AvatarImage } from '@shared/crew'
import { CharacterAvatar, CrewPortrait } from '../../components/Avatar'
import { CardSection, ChoicePicker, DropdownMenu, IconButton, Pill, SearchField, Spinner, ValueRow } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader, Sheet, SheetPage, useDismiss } from '../../components/Overlay'
import { HStack, IconSlot, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { AVATAR_COLORS, AVATAR_SHAPES } from '../../lib/theme'
import { useStore } from '../../store/context'
import { botSections } from '@shared/bot-sections'
import { useAgentModels } from './agent-models'
import { AgentModelPicker } from './AgentModelPicker'
import { errorText, fillDefaults, isValid, lastPathComponent, normalized, usePlugins, type Plugins } from './drafts'
import { FormSheet } from '../marketplace/pieces'
import { SkillSheet, type SkillRef } from '../marketplace/SkillSheet'
import { AnchoredPanel, AutoTextArea, Field, SwitchRow } from './parts'
import { useKithInfo } from './kith/use-kith'
import { HqSettings } from './kith/HqSettings'
import './bots.css'

/** Create or edit a bot in a modal: the settings form plus Close / Save. */
export function BotEditorView({ draft: initial }: { draft: BotDraft }) {
  const store = useStore()
  const dismiss = useDismiss()
  const plugins = usePlugins(store)
  const isNew = !initial.id
  const [draft, setDraft] = useState(() => (isNew ? fillDefaults(store, initial, { connectors: [], skills: [] }) : initial))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const online = store.connection.kind === 'online'

  // A new bot's connectors and skills start on once the computer has listed them.
  useEffect(() => {
    if (isNew && plugins) setDraft((d) => fillDefaults(store, d, plugins))
  }, [isNew, plugins, store])

  const save = () => {
    if (!isValid(draft) || saving || !online) return
    setSaving(true)
    setError(null)
    store
      .save(normalized(draft))
      .then((bot) => {
        dismiss()
        if (isNew) store.setSelection(bot.id)
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setSaving(false))
  }

  return (
    <SheetPage>
      <ModalHeader
        title={isNew ? 'New bot' : 'Settings'}
        trailing={saving ? <Spinner /> : <IconButton title={isNew ? 'Create' : 'Save'} icon="checkmark" disabled={!isValid(draft) || saving || !online} onClick={save} />}
      />
      <div className="bot-editor-body">
        <BotSettingsForm draft={draft} onChange={setDraft} error={error} plugins={plugins} />
      </div>
    </SheetPage>
  )
}

/**
 * Which settings a form shows: all of them (a new bot, the editor sheet), what changes often
 * (instructions, model, fast mode: the inspector's Details tab) or the rest (its Settings tab).
 */
export type FormPart = 'all' | 'often' | 'rarely'

/** The desktop inspector next to a conversation: the same form, saved as you edit. */
export function BotSettingsPanel({ botId, part }: { botId: string; part: FormPart }) {
  const store = useStore()
  const plugins = usePlugins(store)
  const [draft, setDraft] = useState<BotDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const change = useCallback((update: (d: BotDraft) => BotDraft) => setDraft((d) => (d ? update(d) : d)), [])

  useEffect(() => {
    const bot = store.bots.get(botId)
    setDraft(bot ? draftOf(bot) : null)
    // Only a different bot reloads the form; the host's echo of a save must not undo typing.
  }, [botId])

  // Autosave a moment after the last change.
  useEffect(() => {
    const bot = store.bots.get(botId)
    if (!draft || !bot || JSON.stringify(draft) === JSON.stringify(draftOf(bot)) || !isValid(draft)) return
    const timer = setTimeout(() => {
      store
        .save(normalized(draft))
        .then(() => setError(null))
        .catch((e: unknown) => setError(errorText(e)))
    }, 600)
    return () => clearTimeout(timer)
  }, [draft])

  return draft ? <BotSettingsForm draft={draft} onChange={change} error={error} plugins={plugins} part={part} /> : null
}

/** Bot settings, in sections in the Settings style (`CardSection`). */
function BotSettingsForm({ draft, onChange, error, plugins, part = 'all' }: {
  draft: BotDraft
  onChange: (update: (d: BotDraft) => BotDraft) => void
  error: string | null
  plugins: Plugins | null
  part?: FormPart
}) {
  const store = useStore()
  const [pickingAvatar, setPickingAvatar] = useState(false)
  // What the avatar shows now; null when it is drawn as a shape.
  const image = avatarImage({ id: draft.id ?? '', name: draft.name, kind: store.bots.get(draft.id ?? '')?.kind ?? 'agent', avatarSource: draft.avatarSource })
  const [pickingFolder, setPickingFolder] = useState(false)
  const [viewingSkill, setViewingSkill] = useState<SkillRef | null>(null)
  const avatarRef = useRef<HTMLButtonElement>(null)
  const set = <K extends keyof BotDraft>(key: K, value: BotDraft[K]) => onChange((d) => ({ ...d, [key]: value }))
  // Options belong to one model.
  const setModel = useCallback((model: string | null) => onChange((d) => (d.model === model ? d : { ...d, model, modelOptions: {} })), [onChange])
  const setModelOptions = useCallback((modelOptions: Record<string, string>) => onChange((d) => ({ ...d, modelOptions })), [onChange])
  const models = useAgentModels(draft.backend)
  const saved = draft.id ? (store.bots.get(draft.id) ?? null) : null
  // Kith's project list for the default-project menu; without Kith it stays empty and the menu offers None.
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  useEffect(() => {
    let live = true
    store.projects().then((r) => live && setProjects(r.projects)).catch(() => {})
    return () => { live = false }
  }, [store])

  const backends = store.hello?.backends ?? []
  const backend = backends.find((b) => b.id === draft.backend)
  // An hq bot's Details and Settings tabs sit beside the Kith sections, which show the same facts: those cards go.
  // The editor sheet has no Kith sections, so it keeps everything.
  const kith = useKithInfo(draft.id ?? '')
  const shown = botSections(saved?.hqAgent, part === 'all' || kith?.unsupported ? null : (kith?.info ?? null), !kith || kith.unsupported)
  const connectors = plugins?.connectors ?? []
  const skills = plugins?.skills ?? []

  const instructions = (
    <Field label="Standing instructions" detail="Rules that always apply. Put task-specific requests in the chat instead.">
      <AutoTextArea className="field-box" value={draft.description} placeholder="e.g. Reviews PRs. Never pushes without asking." minRows={3} maxRows={8} onChange={(v) => set('description', v)} />
    </Field>
  )
  // hq is the one source of an hq bot's permission, model, effort and Fast mode: one set of rows replaces Codync's own.
  const model = kith && !shown.codyncSettings ? [<HqSettings key="hq" kith={kith} />] : [
    <AgentModelPicker key="model" backend={draft.backend} models={models} selection={draft.model} onChange={setModel} options={draft.modelOptions ?? {}} onOptionsChange={setModelOptions} />,
    (draft.backend !== 'custom' && models.catalog?.fastMode) || draft.fastMode || (saved?.backend === draft.backend && fastModeShown(saved)) ? (
      // Shown while the agent offers it (its model list, or the bot's own sessions), or while it's on.
      <div key="fast" className="fade-in">
        <SwitchRow
          title="Fast mode"
          detail={(saved && fastModeRefusal(saved)) ?? 'Faster replies for more usage, on models that offer it.'}
          on={draft.fastMode ?? false}
          onChange={(on) => set('fastMode', on)}
        />
      </div>
    ) : null,
  ]

  const agent = shown.backendPicker ? (
    <VStack key="agent" gap={8}>
      <ValueRow label="Agent">
        <ChoicePicker
          selection={draft.backend}
          options={[
            ...backends.map((b) => ({ id: b.id, label: b.available ? b.name : `${b.name} (not installed)`, leading: <AgentIcon registry={b.registry ?? b.id} size={14} /> })),
            { id: 'custom', label: 'Custom command', leading: <AgentIcon registry="custom" size={14} /> },
          ]}
          onChange={(id) => set('backend', id)}
        />
      </ValueRow>
      {backend && !backend.available ? <Text size="caption" tone="attention">{backend.installHint}</Text> : null}
      {draft.backend === 'custom' ? (
        <input
          className="field-box fade-in bot-command"
          value={draft.command ?? ''}
          placeholder="ACP command, e.g. my-agent --acp"
          spellCheck={false}
          onChange={(e) => set('command', e.target.value || null)}
        />
      ) : null}
    </VStack>
  ) : null

  if (part === 'often') {
    return (
      <div className="bot-form">
        <div className="bot-form-content">
          {shown.instructions ? <CardSection title="Instructions">{instructions}</CardSection> : null}
          <CardSection title="Agent">
            {agent}
            {model}
          </CardSection>
          {error ? <Text size="footnote" tone="danger" className="fade-in">{error}</Text> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="bot-form">
      <div className="bot-form-content">
        <CardSection title="Profile">
          <ValueRow label="Avatar">
            <button ref={avatarRef} className="avatar-button small" title="Edit Bot avatar" aria-label="Edit Bot avatar" onClick={() => setPickingAvatar((p) => !p)}>
              {image ? <CrewPortrait image={image} size={24} /> : <CharacterAvatar shape={draft.avatarShape} color={draft.avatarColor} size={24} />}
            </button>
            <AnchoredPanel open={pickingAvatar} onClose={() => setPickingAvatar(false)} anchor={avatarRef}>
              <div className="avatar-picker-panel">
                <AvatarPicker
                  source={draft.avatarSource ?? 'auto'}
                  shape={draft.avatarShape}
                  color={draft.avatarColor}
                  isGroup={store.bots.get(draft.id ?? '')?.kind === 'group'}
                  auto={avatarImage({ id: draft.id ?? '', name: draft.name, kind: 'agent', avatarSource: 'auto' })}
                  onSource={(s) => set('avatarSource', s)}
                  // A shape or colour pick means the shape is what the bot shows.
                  onShape={(s) => onChange((d) => ({ ...d, avatarShape: s, avatarSource: 'shape' }))}
                  onColor={(c) => onChange((d) => ({ ...d, avatarColor: c, avatarSource: 'shape' }))}
                />
              </div>
            </AnchoredPanel>
          </ValueRow>
          {/* A new bot is named from its first conversations (Grok Bot's flow); rename it any time after. */}
          {draft.id ? (
            <Field label="Name">
              <input className="field-box" value={draft.name} placeholder="Name" onChange={(e) => set('name', e.target.value)} />
            </Field>
          ) : null}
          {part === 'all' ? instructions : null}
        </CardSection>

        {/* In the inspector the agent and its model are on the Details tab; what's left is where it works. */}
        <CardSection title={part === 'all' ? 'Agent' : 'Workspace'}>
          <ValueRow label="Computer">
            <Text truncate>{store.hostName}</Text>
          </ValueRow>
          {part === 'all' ? agent : null}
          {part === 'all' ? model : null}
          <ValueRow
            label="Workspace"
            detail={
              draft.cwd
                ? 'This project is the default starting folder. The bot can work elsewhere when you ask.'
                : 'This bot has its own space for files. It can work in other folders when you ask.'
            }
          >
            <DropdownMenu
              title={draft.cwd || 'A persistent workspace allocated for this bot'}
              items={() => [
                { title: 'Personal workspace', selected: !draft.cwd, action: () => set('cwd', '') },
                { title: 'Choose project folder…', selected: !!draft.cwd, action: () => setPickingFolder(true) },
              ]}
            >
              <Pill outlined className="workspace-pill">
                <Text truncate className="workspace-pill-label">{draft.cwd ? lastPathComponent(draft.cwd) : 'Personal'}</Text>
                <Icon name="chevron.down" size={10} weight="semibold" color="var(--secondary)" />
              </Pill>
            </DropdownMenu>
          </ValueRow>
          {saved?.kind !== 'group' ? (
            <ValueRow label="Default project" detail="New chats, threads and tasks of this bot start in this Kith project, unless one is picked there.">
              <DropdownMenu
                title={draft.project || 'No default project'}
                items={() => [
                  { title: 'None', selected: !draft.project, action: () => set('project', null) },
                  ...(projects ?? []).map((p) => ({ title: p.id, selected: draft.project === p.id, action: () => set('project', p.id) })),
                  ...(draft.project && !(projects ?? []).some((p) => p.id === draft.project) ? [{ title: draft.project, selected: true, action: () => {} }] : []),
                ]}
              >
                <Pill outlined className="workspace-pill">
                  <Text truncate className="workspace-pill-label">{draft.project || 'None'}</Text>
                  <Icon name="chevron.down" size={10} weight="semibold" color="var(--secondary)" />
                </Pill>
              </DropdownMenu>
            </ValueRow>
          ) : null}
          {shown.codyncSettings ? <ValueRow
            label="Permissions"
            detail={
              draft.permission === 'auto'
                ? "Tool requests are approved automatically. Your agent's own settings (like Claude Code's permission rules) still apply."
                : "You'll get an approval card and a notification whenever the agent asks."
            }
          >
            <ChoicePicker
              selection={draft.permission}
              options={[
                { id: 'ask', label: 'Ask me' },
                { id: 'auto', label: 'Approve automatically' },
              ]}
              onChange={(id) => set('permission', id)}
            />
          </ValueRow> : null}
        </CardSection>

        <CardSection title="Activity">
          <SwitchRow title="Notifications" detail="Get notified when this bot finishes or needs you" on={draft.notify ?? true} onChange={(on) => set('notify', on)} />
          {store.screen && part === 'all' ? (
            <SwitchRow
              title="Use the computer"
              detail={
                store.screen.platform !== 'windows' && !(store.screen.enabled && store.screen.connected && store.screen.capture && store.screen.input)
                  ? 'Let this bot use apps. On that computer, open Kith → Settings → Computer access to set up permissions first.'
                  : store.screen.enabled
                  ? 'Let this bot see the screen and use the mouse and keyboard. You can watch and take over from your phone.'
                  : store.screen.computerUse
                    ? 'Let this bot see the screen and use the mouse and keyboard.'
                    : "Let this bot see the screen and use the mouse and keyboard. On that computer, open Kith → Settings → Computer access to set up permissions first."
              }
              on={draft.computer ?? false}
              onChange={(on) => set('computer', on)}
            />
          ) : null}
        </CardSection>

        <PluginToggles
          title="Connectors"
          empty="No connectors yet. Add GitHub, Linear, Notion and more from Extensions."
          items={connectors.map((c) => ({ id: c.id, name: c.name, detail: c.command ?? c.url ?? '' }))}
          selection={draft.connectors ?? []}
          onChange={(ids) => set('connectors', ids)}
        />
        <PluginToggles
          title="Skills"
          empty="No skills yet. Get some from Extensions, or write your own."
          items={skills.map((s) => ({ id: s.id, name: s.name, detail: s.description }))}
          selection={draft.skills ?? []}
          onChange={(ids) => set('skills', ids)}
          onInfo={(s) => setViewingSkill({ id: s.id, name: s.name, description: s.detail })}
        />
        {error ? <Text size="footnote" tone="danger" className="fade-in">{error}</Text> : null}
      </div>
      <FormSheet open={viewingSkill !== null} onClose={() => setViewingSkill(null)}>
        {viewingSkill ? <SkillSheet key={viewingSkill.name} skill={viewingSkill} /> : null}
      </FormSheet>
      <Sheet open={pickingFolder} onClose={() => setPickingFolder(false)} width={460} height={520}>
        <FolderPicker
          start={draft.cwd || store.hello?.home || null}
          onPick={(path) => {
            set('cwd', path)
            setPickingFolder(false)
          }}
        />
      </Sheet>
    </div>
  )
}

/** A card of on/off switches for the connectors or skills installed on the computer. */
function PluginToggles({ title, empty, items, selection, onChange, onInfo }: {
  title: string
  empty: string
  items: { id: string; name: string; detail: string }[]
  selection: string[]
  onChange: (ids: string[]) => void
  /** Shows an item's details from an info button beside its switch. */
  onInfo?: (item: { id: string; name: string; detail: string }) => void
}) {
  return (
    <CardSection title={title}>
      {items.length ? null : <Text tone="secondary">{empty}</Text>}
      {items.map((item) => {
        const row = (
          <SwitchRow
            key={item.id}
            title={item.name}
            detail={item.detail || null}
            on={selection.includes(item.id)}
            onChange={(on) => onChange([...selection.filter((id) => id !== item.id), ...(on ? [item.id] : [])])}
          />
        )
        return onInfo ? (
          <HStack key={item.id} gap={4}>
            <div className="plugin-toggle">{row}</div>
            <IconButton title={`About ${item.name}`} icon="info.circle" onClick={() => onInfo(item)} />
          </HStack>
        ) : row
      })}
    </CardSection>
  )
}

function AvatarPicker({ source, shape, color, auto, isGroup, onSource, onShape, onColor }: {
  source: string
  shape: string
  color: string
  /** What Automatic shows for this bot. */
  auto: AvatarImage | null
  /** A group's face is its members', so only the shape applies. */
  isGroup: boolean
  onSource: (source: string) => void
  onShape: (s: string) => void
  onColor: (c: string) => void
}) {
  const images = (kind: AvatarImage['kind'], names: readonly string[]) =>
    names.map((name) => {
      const value = `${kind}:${name}`
      return (
        <button key={value} className={`swatch ${source === value ? 'on' : ''}`} aria-label={name} aria-pressed={source === value} onClick={() => onSource(value)}>
          <CrewPortrait image={{ kind, name }} size={36} />
        </button>
      )
    })
  return (
    <VStack gap={12}>
      {isGroup ? null : <>
      <div className="swatch-label">Automatic</div>
      <div className="swatch-grid">
        <button className={`swatch ${source === 'auto' ? 'on' : ''}`} aria-label="Automatic" aria-pressed={source === 'auto'} onClick={() => onSource('auto')}>
          {auto ? <CrewPortrait image={auto} size={36} /> : null}
        </button>
      </div>
      <div className="swatch-label">Crew</div>
      <div className="swatch-grid">{images('crew', CREW)}</div>
      <div className="swatch-label">Spares</div>
      <div className="swatch-grid">{images('spare', SPARES)}</div>
      </>}
      <div className="swatch-label">Shapes</div>
      <div className="swatch-row">
        {AVATAR_SHAPES.map((s) => (
          <button key={s} className={`swatch ${source === 'shape' && s === shape ? 'on' : ''}`} aria-label={`${s} shape`} aria-pressed={source === 'shape' && s === shape} onClick={() => onShape(s)}>
            <CharacterAvatar shape={s} color={color} size={36} />
          </button>
        ))}
      </div>
      <div className="swatch-row">
        {AVATAR_COLORS.map((c) => (
          <button key={c.id} className={`swatch ${c.id === color ? 'on' : ''}`} aria-label={c.label} aria-pressed={c.id === color} onClick={() => onColor(c.id)}>
            <span className="swatch-color" style={{ background: c.hex }} />
          </button>
        ))}
      </div>
    </VStack>
  )
}

/** Browses folders on the host, drilling down in place. */
export function FolderPicker({ start, onPick }: { start: string | null; onPick: (path: string) => void }) {
  // The folders opened so far; the last one is shown.
  const [stack, setStack] = useState<(string | null)[]>([start])
  const [forward, setForward] = useState(true)
  const current = stack[stack.length - 1] ?? null
  return (
    <SheetPage>
      <HStack>
        {stack.length > 1 ? (
          <HStack align="stretch" className="fade-in folder-back">
            <IconButton
              title="Back"
              icon="chevron.left"
              onClick={() => {
                setForward(false)
                setStack((s) => s.slice(0, -1))
              }}
            />
          </HStack>
        ) : null}
        <div className="folder-title">
          <ModalHeader title={current ? lastPathComponent(current) : 'Folders'} />
        </div>
      </HStack>
      <div className="folder-levels">
        <FolderLevel
          key={stack.length}
          path={current}
          forward={forward}
          onPick={onPick}
          onOpen={(path) => {
            setForward(true)
            setStack((s) => [...s, path])
          }}
        />
      </div>
    </SheetPage>
  )
}

/** One folder's subfolders. */
function FolderLevel({ path, forward, onPick, onOpen }: { path: string | null; forward: boolean; onPick: (path: string) => void; onOpen: (path: string) => void }) {
  const store = useStore()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let live = true
    store
      .listDirs(path)
      .then((l) => live && setListing(l))
      .catch((e: unknown) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [store, path])

  const dirs = listing?.dirs.filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase())) ?? []

  return (
    <div className={`bot-form level-slide ${forward ? 'from-trailing' : 'from-leading'}`}>
      <div className="bot-form-content folder-level-content">
        <SearchField value={filter} onChange={setFilter} />
        {listing ? (
          <>
            <CardSection footer={listing.path}>
              <button className="press folder-use" onClick={() => onPick(listing.path)}>
                <Icon name="checkmark.circle.fill" size={13} />
                <Text truncate>{`Use “${lastPathComponent(listing.path)}”`}</Text>
              </button>
            </CardSection>
            {listing.roots && listing.roots.length > 1 ? (
              <CardSection title="Locations">
                {listing.roots.map((root) => (
                  <button key={root.path} className="press folder-row" onClick={() => onOpen(root.path)}>
                    <IconSlot width={20}>
                      <Icon name="folder" size={12} color="var(--secondary)" />
                    </IconSlot>
                    <Text tone="text" truncate grow>{root.name}</Text>
                    <Icon name="chevron.right" size={10} weight="semibold" color="var(--tertiary)" />
                  </button>
                ))}
              </CardSection>
            ) : null}
            {dirs.length ? (
              <CardSection>
                {dirs.map((dir) => (
                  <button key={dir.path} className="press folder-row" onClick={() => onOpen(dir.path)}>
                    <IconSlot width={20}>
                      <Icon name={dir.isGit ? 'arrow.triangle.branch' : 'folder'} size={12} color={dir.isGit ? 'var(--accent)' : 'var(--secondary)'} />
                    </IconSlot>
                    <Text tone="text" truncate grow>{dir.name}</Text>
                    <Icon name="chevron.right" size={10} weight="semibold" color="var(--tertiary)" />
                  </button>
                ))}
              </CardSection>
            ) : null}
          </>
        ) : error ? (
          <Text tone="danger">{error}</Text>
        ) : (
          <HStack align="stretch" justify="center">
            <Spinner size={20} />
          </HStack>
        )}
      </div>
    </div>
  )
}
