import { useState } from 'react'
import { Spinner } from '../Controls'
import { Icon } from '../Icon'
import { Sheet } from '../Overlay'
import { LiveDot } from './Badges'
import { resumeCommand, writerBannerOf, type WriterPhase } from './logic.ts'
import type { Pair } from './pair.ts'
import './kith.css'

/** Replaces the dock for a thread a terminal holds (continue-anywhere/spec.md). Announces changes politely. */
export function WriterBanner({ phase, mac, pair, mine = true, person, pending = false, onTakeOver, onRetry }: {
  phase: WriterPhase
  mac: string
  pair: Pair
  /** Take over is only for the person whose terminal it is. */
  mine?: boolean
  person?: string
  /** The parent is acting on a click already: the button disables (no double take-over). */
  pending?: boolean
  onTakeOver?: () => void
  onRetry?: () => void
}) {
  const m = writerBannerOf({ phase, mac, mine, person })
  const click = m.button === 'Try again' ? onRetry : onTakeOver
  return (
    <div className="kc-banner kith-glass" role="group" aria-live="polite" aria-label={`${m.title}. ${m.sentence}`}>
      <span className={`kc-banner-icon ${m.icon}`} aria-hidden>
        {m.icon === 'dot' ? <LiveDot pair={pair} size={10} /> : m.icon === 'spinner' ? <Spinner size={16} /> : <Icon name={m.icon === 'warning' ? 'exclamationmark.triangle' : 'terminal'} size={16} />}
      </span>
      <span className="kc-banner-text">
        <span className="kc-banner-title">{m.title}</span>
        <span className="kc-banner-sentence kith-text-secondary">{m.sentence}</span>
      </span>
      {m.button ? (
        <button className="kc-banner-button" disabled={pending} onClick={click} aria-label={m.button} title={m.button === 'Take over' ? `Closes the terminal session on ${mac} so you can reply here.` : undefined}>
          {m.button}
        </button>
      ) : null}
    </div>
  )
}

/** "Take over from the terminal?": the command in mono with Copy. Enter takes over, Esc cancels. */
export function TakeOverDialog({ open, mac, agent, resumeId, pending = false, onConfirm, onCancel }: {
  open: boolean
  mac: string
  agent: string
  resumeId: string
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [copied, setCopied] = useState(false)
  const command = resumeCommand(agent, resumeId)
  const copy = () => {
    void navigator.clipboard?.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Sheet open={open} onClose={onCancel} width={360}>
      <form
        className="kc-confirm"
        onSubmit={(e) => {
          e.preventDefault()
          if (!pending) onConfirm()
        }}
      >
        <h2 className="kc-confirm-title kith-text-top-bar">Take over from the terminal?</h2>
        <p className="kc-confirm-text kith-text-secondary">{`This closes the terminal session on ${mac}. You can get it back with`}</p>
        <div className="kc-confirm-command">
          <code className="kith-text-code">{command}</code>
          <button type="button" className="kc-confirm-copy kith-text-secondary" onClick={copy} aria-label="Copy command">
            <Icon name={copied ? 'checkmark' : 'doc.on.doc'} size={11} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="kc-confirm-buttons">
          <button type="button" className="kc-confirm-cancel kith-text-top-bar" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="kc-confirm-go kith-text-top-bar" disabled={pending} data-autofocus>
            Take over
          </button>
        </div>
      </form>
    </Sheet>
  )
}
