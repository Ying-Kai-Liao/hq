import { useState } from 'react'
import { folderName, isGroup, type Bot } from '@shared/models'
import { BotAvatar, GroupAvatar } from '../../components/Avatar'
import { Button, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader, useDismiss } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { errorText } from './drafts'
import { AutoTextArea, BotChip, Field } from './parts'
import './bots.css'

/**
 * Create a group chat, or change its name, what it's for and who's in it. Bots are
 * picked like recipients: chips on top, a search, and the bots not in it yet.
 */
export function GroupEditorView({ group, members: initialMembers = [] }: { group: Bot | null; members?: string[] }) {
  const store = useStore()
  const dismiss = useDismiss()
  // The group being edited; null creates one.
  const groupId = group?.id ?? null
  const [name, setName] = useState(group?.name ?? '')
  const [about, setAbout] = useState(group?.description ?? '')
  const [members, setMembers] = useState<string[]>(group?.members ?? initialMembers)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Bot | null>(null)

  const picked = members.map((id) => store.bots.get(id)).filter((b): b is Bot => !!b)
  // Bots that can still join, filtered by the search.
  const q = query.trim().toLowerCase()
  const candidates = store.roster.filter((b) => !isGroup(b) && !members.includes(b.id) && (!q || b.name.toLowerCase().includes(q)))
  const isNew = groupId === null
  const canSave = members.length > 0 && !saving
  // "Alice, Bob" when no name is typed.
  const defaultName = picked.length ? picked.map((b) => b.name).join(', ') : 'Name'
  const current = groupId ? store.bots.get(groupId) : undefined

  const toggle = (id: string) => {
    setMembers((list) => (list.includes(id) ? list.filter((m) => m !== id) : [...list, id]))
    setQuery('')
  }

  const save = () => {
    setSaving(true)
    setError(null)
    const typed = name.trim()
    const finalName = typed || defaultName
    const description = about.trim()
    const done = groupId
      ? store.updateGroup({ id: groupId, kind: 'group', name: finalName, description, members, pinned: store.bots.get(groupId)?.pinned })
      : store.createGroup(finalName, description, members)
    void Promise.resolve(done)
      .then(() => dismiss())
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setSaving(false))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' }}>
      <ModalHeader title={isNew ? 'New group chat' : 'Group chat'} trailing={saving ? <Spinner /> : <IconButton title={isNew ? 'Create' : 'Save'} icon="checkmark" disabled={!canSave} onClick={save} />} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, ...font('body') }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <GroupAvatar members={picked} size={72} />
          </div>
          <Field label={`Bots · ${members.length}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {picked.length ? (
                <div className="chip-row">
                  {picked.map((bot) => (
                    <BotChip key={bot.id} bot={bot} onRemove={() => toggle(bot.id)} />
                  ))}
                </div>
              ) : null}
              <input
                className="field-box"
                value={query}
                placeholder={picked.length ? 'Add another bot' : 'Search bots'}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && candidates[0]) toggle(candidates[0].id)
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {candidates.map((bot) => (
                  <button key={bot.id} className="press pick-row fade-in" aria-label={`Add ${bot.name}`} onClick={() => toggle(bot.id)}>
                    <BotAvatar bot={bot} size={26} animated={false} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bot.name}</span>
                      <span style={{ ...font('caption'), color: 'var(--tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{folderName(bot)}</span>
                    </span>
                    <Icon name="plus.circle" size={20} color="var(--tertiary)" />
                  </button>
                ))}
              </div>
            </div>
            <span style={{ ...font('caption'), color: 'var(--tertiary)' }}>Everyone answers in turn unless you @mention someone. Each bot works in its own folder with its own tools.</span>
          </Field>
          <Field label="Name">
            <input className="field-box" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="About">
            <AutoTextArea className="field-box" value={about} placeholder="What this group works on (optional)" minRows={2} maxRows={5} onChange={setAbout} />
          </Field>
          {error ? <span className="fade-in" style={{ ...font('footnote'), color: 'var(--danger)' }}>{error}</span> : null}
          {current ? (
            <div style={{ paddingTop: 8 }}>
              <Button kind="secondary" onClick={() => setConfirmDelete(current)}>
                Delete group chat
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <DeleteBotDialog bot={confirmDelete} onClose={() => setConfirmDelete(null)} onDeleted={dismiss} />
    </div>
  )
}

/** The one "Delete <bot>?" confirmation (kit `deleteBotConfirmation`). */
function DeleteBotDialog({ bot, onClose, onDeleted }: { bot: Bot | null; onClose: () => void; onDeleted: () => void }) {
  const store = useStore()
  return (
    <Dialog
      open={bot !== null}
      title={`Delete ${bot?.name ?? 'bot'}?`}
      message={bot && isGroup(bot) ? 'Its bots and their own chats stay.' : 'Files it changed on your computer stay as they are.'}
      actions={[
        {
          title: 'Delete bot and its conversation',
          destructive: true,
          action: () => {
            if (bot) store.delete(bot)
            onDeleted()
          },
        },
      ]}
      onClose={onClose}
    />
  )
}
