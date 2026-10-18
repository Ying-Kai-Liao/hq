import { useRef, useState, type ReactNode } from 'react'
import { ResizeHandle } from '../../components/Controls'
import { usePresence } from '../../components/Overlay'

/** Animate the available conversation width on both opening and closing; its edge drags the width. */
export function ChatSidePanel({ open, width, min, max, onResize, children }: {
  open: boolean
  width: number
  min: number
  max: number
  onResize: (width: number) => void
  children: ReactNode
}) {
  // Animate explicit open/close actions without animating the initial mount.
  const { mounted, shown } = usePresence(open, 300, false)
  const last = useRef({ width, children })
  const [resizing, setResizing] = useState(false)
  if (open) last.current = { width, children }
  const content = open ? { width, children } : last.current
  return (
    <div className={`side-panel ${shown ? 'shown' : ''} ${resizing ? 'resizing' : ''}`} inert={!open}
      style={{ width: shown ? content.width + 1 : 0 }}>
      {mounted ? <>
        <ResizeHandle label="Resize panel" width={content.width} min={min} max={max} edge="leading" onResize={onResize} onDragging={setResizing} />
        <div style={{ width: content.width, height: '100%', flex: 'none' }}>{content.children}</div>
      </> : null}
    </div>
  )
}
