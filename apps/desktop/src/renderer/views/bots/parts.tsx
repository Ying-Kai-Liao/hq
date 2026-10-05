import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Bot } from '@shared/models'
import { BotAvatar } from '../../components/Avatar'
import { Switch } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { usePresence } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import './bots.css'

/** A labeled input inside a section row: label (and an optional note) over the field. */
export function Field({ label, detail, children }: { label: string; detail?: string | null; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: 'var(--text)' }}>{label}</span>
        {detail ? <span style={{ ...font('caption'), color: 'var(--secondary)', lineHeight: 1.35 }}>{detail}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** An on/off row: title and a short note, the switch on the right. */
export function SwitchRow({ title, detail, on, onChange }: { title: string; detail?: string | null; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Switch on={on} onChange={onChange}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: 'var(--text)' }}>{title}</span>
        {detail ? <span style={{ ...font('caption'), color: 'var(--secondary)', lineHeight: 1.35 }}>{detail}</span> : null}
      </span>
    </Switch>
  )
}

/** A multi-line field that grows with its text between `minRows` and `maxRows` (`axis: .vertical`). */
export function AutoTextArea({ value, onChange, placeholder, minRows, maxRows, className, onKeyDown }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minRows: number
  maxRows: number
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const style = getComputedStyle(el)
    const line = parseFloat(style.lineHeight) || 15
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, line * minRows + pad), line * maxRows + pad)}px`
  }, [value, minRows, maxRows])
  return <textarea ref={ref} rows={minRows} className={className} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
}

/** A picked bot (To: field, group editor); its x takes it back out. */
export function BotChip({ bot, onRemove }: { bot: Bot; onRemove: () => void }) {
  return (
    <span className="bot-chip">
      <BotAvatar bot={bot} size={20} animated={false} />
      <span style={{ ...font('body'), color: 'var(--text)', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bot.name}</span>
      <button style={{ width: 18, height: 18, display: 'grid', placeItems: 'center' }} aria-label={`Remove ${bot.name}`} title={`Remove ${bot.name}`} onClick={onRemove}>
        <Icon name="xmark" size={10} weight="semibold" color="var(--secondary)" />
      </button>
    </span>
  )
}

/** A floating panel next to `anchor` that a click anywhere else closes (kit `AnchoredPanel`). */
export function AnchoredPanel({ open, onClose, anchor, children }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  const { mounted, shown } = usePresence(open, 120)
  const [rect, setRect] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    if (open && anchor.current) setRect(anchor.current.getBoundingClientRect())
  }, [open, anchor])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])
  if (!mounted || !rect) return null
  const W = window.innerWidth
  const H = window.innerHeight
  const below = H - rect.bottom >= rect.top
  const leading = rect.left + rect.width / 2 < W * 0.6
  const inset = Math.max(8, W - Math.min(320, W - 16) - 8)
  return createPortal(
    <div className={`anchored ${shown ? 'shown' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="anchored-panel"
        style={{
          position: 'absolute',
          [below ? 'top' : 'bottom']: below ? rect.bottom + 6 : H - rect.top + 6,
          ...(leading ? { left: Math.min(Math.max(8, rect.left), inset) } : { right: Math.min(Math.max(8, W - rect.right), inset) }),
          transformOrigin: `${below ? 'top' : 'bottom'} ${leading ? 'left' : 'right'}`,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
