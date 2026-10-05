import { useEffect, useMemo, useState } from 'react'
import type { BotDraft } from '@shared/models'
import { Icon } from '../../components/Icon'
import { ModalHeader } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import './bots.css'

/** Swift's `JSONEncoder` with `.prettyPrinted, .sortedKeys, .withoutEscapingSlashes`; nil fields are left out. */
export function encodeTemplate(draft: BotDraft): string {
  const { id: _id, pinned: _pinned, hidden: _hidden, ...rest } = draft
  const sorted = Object.fromEntries(
    Object.entries(rest)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return JSON.stringify(sorted, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, '$1 : ')
}

/** A portable settings snapshot, with no conversation identity or runtime state. */
export function BotTemplateView({ draft }: { draft: BotDraft }) {
  const encoded = useMemo(() => encodeTemplate(draft), [draft])
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(encoded).then(() => setCopied(true))
  }

  // Return copies (the default action).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        copy()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div style={{ width: 560, height: 540, display: 'flex', flexDirection: 'column', background: 'var(--background)' }}>
      <ModalHeader title="Create template" />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 20, padding: '0 24px 24px' }}>
        <span style={{ ...font('subheadline'), color: 'var(--secondary)' }}>{draft.name}</span>
        <span style={{ ...font('callout'), color: 'var(--secondary)' }}>Copy this bot’s settings to reuse as a template. Conversation history and conversation ID are excluded.</span>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--surface)', borderRadius: 12 }}>
          <pre className="selectable" style={{ ...font(12, 'regular', 'monospaced'), margin: 0, padding: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {encoded}
          </pre>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...font('caption'), color: 'var(--secondary)', flex: 1 }}>Includes workspace preferences and agent configuration.</span>
          <button
            className="press"
            style={{ ...font(13, 'semibold'), display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', color: 'var(--on-accent)', background: 'var(--accent-fill)', borderRadius: 9 }}
            onClick={copy}
          >
            <Icon key={copied ? 'checkmark' : 'square.on.square'} name={copied ? 'checkmark' : 'square.on.square'} size={13} weight="semibold" className="fade-in" />
            {copied ? 'Copied' : 'Copy template'}
          </button>
        </div>
      </div>
    </div>
  )
}
