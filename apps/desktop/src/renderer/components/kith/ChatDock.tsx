import { useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Spinner } from '../Controls'
import { Icon } from '../Icon'
import { AnchoredMenu, type MenuItem } from '../Overlay'
import { dockAction, dockCallVisible } from './logic.ts'
import './kith.css'

/**
 * The composer box: a floating glass pill (54) with + and a field, a mic when empty and send when there is text,
 * and a round glass call button to its right that folds away while there is anything to send.
 *
 * It is the shell only. The existing composer's features (slash commands, @mentions, dictation, attachments,
 * drafts, queue-while-working) plug in through `above`, `attachments`, `field`, and `attachMenu`; the dock owns
 * no store and no draft.
 */
export function ChatDock({
  value,
  onChange,
  onSend,
  onMic,
  onCall,
  placeholder = 'Ask the crew…',
  showsCall = true,
  attachMenu = [],
  attachments,
  hasAttachments = false,
  above,
  field,
  trailing,
  pending = false,
  disabled = false,
  micActive = false,
  fieldRef,
  onKeyDown,
}: {
  value: string
  onChange: (text: string) => void
  onSend: () => void
  /** Dictation: the mic's tap. */
  onMic?: () => void
  onCall?: () => void
  placeholder?: string
  showsCall?: boolean
  /** The + menu: attach files, photos... Each item is a callback; no items, no menu (the button is hidden). */
  attachMenu?: MenuItem[]
  /** Chips for what is attached, shown inside the pill above the field. */
  attachments?: ReactNode
  /** Something is attached: send shows even with no text. */
  hasAttachments?: boolean
  /** Above the pill: the "Replying in thread" pill, the slash menu, the queued line. */
  above?: ReactNode
  /** Replaces the plain text field (the host's textarea with mentions and slash handling). */
  field?: ReactNode
  /** Extra controls inside the pill, left of mic/send. */
  trailing?: ReactNode
  /** A send is in flight: send disables and shows a spinner. */
  pending?: boolean
  disabled?: boolean
  micActive?: boolean
  fieldRef?: Ref<HTMLTextAreaElement>
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const plus = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const hasText = value.trim().length > 0
  const action = dockAction({ hasText, hasAttachments })
  const callShown = dockCallVisible({ showsCall, hasText, hasAttachments })
  const send = () => {
    if (!pending && !disabled) onSend()
  }
  return (
    <div className="kc-dock-wrap">
      {above}
      <div className="kc-dock-row">
        <div className="kc-dock kith-glass" data-empty={action === 'mic'}>
          {attachments ? <div className="kc-dock-attachments">{attachments}</div> : null}
          <div className="kc-dock-line">
            {attachMenu.length ? (
              <>
                <button ref={plus} className="kc-dock-plus" aria-label="Attach" aria-haspopup="menu" aria-expanded={menu} disabled={disabled} onClick={() => setMenu(true)}>
                  <Icon name="plus" size={17} weight="medium" />
                </button>
                <AnchoredMenu open={menu} onClose={() => setMenu(false)} anchor={plus} items={() => attachMenu} />
              </>
            ) : null}
            {field ?? (
              <textarea
                ref={fieldRef}
                className="kc-dock-field kith-text-body"
                rows={1}
                value={value}
                placeholder={placeholder}
                aria-label={placeholder}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                  onKeyDown?.(e)
                  if (e.defaultPrevented) return
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
            )}
            {trailing}
            {action === 'send' ? (
              <button className="kc-dock-send" aria-label="Send" disabled={disabled || pending} onClick={send}>
                {pending ? <Spinner size={14} /> : <Icon name="arrow.up" size={14} weight="bold" />}
              </button>
            ) : (
              <button className={`kc-dock-mic ${micActive ? 'active' : ''}`} aria-label={micActive ? 'Stop dictation' : 'Dictate'} aria-pressed={micActive} disabled={disabled || !onMic} onClick={onMic}>
                <Icon name="mic" size={17} weight="medium" />
              </button>
            )}
          </div>
        </div>
        <div className={`kc-dock-call-slot ${callShown ? 'shown' : ''}`} aria-hidden={!callShown} inert={!callShown}>
          <button className="kc-dock-call kith-glass" aria-label="Call" tabIndex={callShown ? 0 : -1} onClick={onCall}>
            <Icon name="phone.fill" size={17} />
          </button>
        </div>
      </div>
    </div>
  )
}
