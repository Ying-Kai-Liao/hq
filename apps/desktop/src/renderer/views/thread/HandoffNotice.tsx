import { useState } from 'react'
import type { Entry, HandoffCard } from '@shared/models'
import { Button, CardForm, CardSection, Disclosure, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader, Sheet } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore as useLiveStore } from '../../store/context'
import { Field } from '../marketplace/pieces'
import './handoff.css'

function Line({ icon, text }: { icon: string; text?: string }) {
  return (
    <span className="handoff-line">
      <Icon name={icon} size={11} />
      <span>{text}</span>
    </span>
  )
}

/** The bot's chat starts over: what the new conversation carries, which the user can edit, or turn down to carry on. */
export function HandoffNotice({ entry, card }: { entry: Entry; card: HandoffCard }) {
  const store = useLiveStore()
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const carried = <pre className="handoff-text handoff-carried">{card.text}</pre>
  if (card.status !== 'draft') {
    return (
      <div className="handoff-folded">
        <Disclosure expanded={expanded} onToggle={() => setExpanded(!expanded)} label={<Line icon="arrow.triangle.branch" text={entry.data.text} />}>
          {carried}
        </Disclosure>
      </div>
    )
  }
  const save = async () => {
    if (draft === null || !draft.trim()) return
    setSaving(true)
    if (await store.editHandoff(entry, draft.trim())) setDraft(null)
    setSaving(false)
  }
  return (
    <div className="handoff-card">
      <Line icon="arrow.triangle.branch" text={entry.data.text} />
      <Disclosure expanded={expanded} onToggle={() => setExpanded(!expanded)} label={<span style={{ ...font('footnote'), fontWeight: 500 }}>What it carries</span>}>
        {carried}
      </Disclosure>
      <div className="handoff-actions">
        {store.answering.has(entry.id) ? <Spinner /> : <>
          <Button kind="secondary" onClick={() => store.keepConversation(entry)}>Keep this conversation</Button>
          <IconButton title="Edit what it carries" icon="pencil" onClick={() => setDraft(card.text ?? '')} />
        </>}
      </div>
      <Sheet open={draft !== null} onClose={() => setDraft(null)} width={620}>
        {draft !== null && <div className="handoff-editor">
          <ModalHeader
            title="Edit the handoff"
            trailing={saving ? <Spinner /> : <IconButton title="Save" icon="checkmark" disabled={!draft.trim()} onClick={() => { void save() }} />}
          />
          <CardForm>
            <CardSection footer="Your next message starts a fresh conversation that begins with this.">
              <Field value={draft} onChange={setDraft} label="Handoff" lines={[10, 24]} mono />
            </CardSection>
          </CardForm>
        </div>}
      </Sheet>
    </div>
  )
}
