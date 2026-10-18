import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Bot } from '@shared/models'
import { BotAvatar } from '../../components/Avatar'
import { RowLabel, Switch } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { anchorPlacement, useEscape, usePresence } from '../../components/Overlay'
import { VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import './bots.css'

/** A labeled input inside a section row: label (and an optional note) over the field, which they name. */
export function Field({ label, detail, children }: { label: string; detail?: string | null; children: ReactNode }) {
  const id = useId()
  return (
    <VStack gap={8} role="group" aria-labelledby={`${id}-label`} aria-describedby={detail ? `${id}-detail` : undefined}>
      <RowLabel label={label} detail={detail} labelId={`${id}-label`} detailId={`${id}-detail`} />
      {children}
    </VStack>
  )
}

/** An on/off row: title and a short note, the switch on the right. */
export function SwitchRow({ title, detail, on, onChange }: { title: string; detail?: string | null; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Switch on={on} onChange={onChange}>
      <RowLabel label={title} detail={detail} />
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
      <Text size="body" tone="text" truncate className="bot-chip-name">{bot.name}</Text>
      <button className="bot-chip-remove" aria-label={`Remove ${bot.name}`} title={`Remove ${bot.name}`} onClick={onRemove}>
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
  useEscape(open, onClose)
  if (!mounted || !rect) return null
  return createPortal(
    <div className={`anchored ${shown ? 'shown' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="anchored-panel" style={anchorPlacement(rect).style}>
        {children}
      </div>
    </div>,
    document.body,
  )
}
