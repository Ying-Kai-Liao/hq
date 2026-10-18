import type { Entry } from '@shared/models'
import { Button, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { font } from '../../lib/fonts'
import { useStore as useLiveStore } from '../../store/context'
import { memoryActions } from './memory-actions'

/** A bot's memory write in the chat: "Remembered: …" with an undo, or a card waiting for the user's approval. */
export function MemoryNotice({ entry }: { entry: Entry }) {
  const store = useLiveStore()
  const card = entry.data.memory
  const actions = memoryActions(card?.status)
  const answering = store.answering.get(entry.id)
  const line = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...font('footnote'), color: 'var(--secondary)', minWidth: 0 }}>
      <Icon name="brain" size={11} />
      <span style={{ overflowWrap: 'anywhere' }}>{entry.data.text}</span>
      {card?.error ? <span style={{ color: 'var(--danger)' }}>{card.error}</span> : null}
    </div>
  )
  if (actions === 'answer') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 14, background: 'var(--bubble-agent)', maxWidth: 520 }}>
        {line}
        <div style={{ display: 'flex', gap: 8 }}>
          {answering ? <Spinner /> : <>
            <Button onClick={() => store.answerMemory(entry, 'approve')}>Remember</Button>
            <Button kind="secondary" onClick={() => store.answerMemory(entry, 'decline')}>Don't</Button>
          </>}
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4 }}>
      {line}
      {actions === 'undo' ? (answering ? <Spinner size={11} /> : <IconButton title="Undo" icon="arrow.uturn.backward" onClick={() => store.answerMemory(entry, 'undo')} />) : null}
    </div>
  )
}
