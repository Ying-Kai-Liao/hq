import { useState } from 'react'
import type { Entry, MemoryFileCard } from '@shared/models'
import { Button, Disclosure, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { font } from '../../lib/fonts'
import { useStore as useLiveStore } from '../../store/context'
import { memoryActions } from './memory-actions'

/** A bot's change to a memory file: "Updated people.md" with the diff and an undo, a change put back and why, or
 *  for a bot that asks first, the change waiting for the user. */
export function MemoryFileNotice({ entry, card }: { entry: Entry; card: MemoryFileCard }) {
  const store = useLiveStore()
  const [expanded, setExpanded] = useState(false)
  const actions = memoryActions(card.status)
  const answering = store.answering.get(entry.id)
  const line = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...font('footnote'), color: 'var(--secondary)', minWidth: 0 }}>
      <Icon name={card.status === 'restored' ? 'exclamationmark.triangle' : 'doc.text'} size={11} />
      <span style={{ overflowWrap: 'anywhere' }}>{entry.data.text}</span>
      {card.big && actions === 'undo' ? <span style={{ color: 'var(--attention)' }}>Removes much of it</span> : null}
    </div>
  )
  const diff = card.diff ? <LineDiff text={card.diff} /> : null
  if (actions === 'answer') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 14, background: 'var(--bubble-agent)', maxWidth: 560 }}>
        {line}
        {diff}
        <div style={{ display: 'flex', gap: 8 }}>
          {answering ? <Spinner /> : <>
            <Button onClick={() => store.answerMemory(entry, 'approve')}>Allow</Button>
            <Button kind="secondary" onClick={() => store.answerMemory(entry, 'decline')}>Don't</Button>
          </>}
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: expanded ? 'flex-start' : 'center', gap: 4, maxWidth: 620, margin: '0 auto', padding: '0 12px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {diff && card.status !== 'restored'
          ? <Disclosure expanded={expanded} onToggle={() => setExpanded(!expanded)} label={line}>{diff}</Disclosure>
          : <div style={{ display: 'flex', justifyContent: 'center' }}>{line}</div>}
      </div>
      {actions === 'undo' ? (answering ? <Spinner size={11} /> : <IconButton title="Undo" icon="arrow.uturn.backward" onClick={() => store.answerMemory(entry, 'undo')} />) : null}
    </div>
  )
}

/** `- ` removed and `+ ` added lines, colored. */
function LineDiff({ text }: { text: string }) {
  return (
    <pre style={{ margin: 0, padding: 8, borderRadius: 8, background: 'var(--code-background)', ...font('footnote'), fontFamily: 'var(--mono, ui-monospace, monospace)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}>
      {text.split('\n').map((line, i) => (
        <div key={i} style={{ color: line.startsWith('+ ') ? 'var(--added)' : line.startsWith('- ') ? 'var(--removed)' : 'var(--secondary)' }}>{line || ' '}</div>
      ))}
    </pre>
  )
}
