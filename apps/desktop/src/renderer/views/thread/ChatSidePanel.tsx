import { useRef, useState, type ReactNode } from 'react'
import { usePresence } from '../../components/Overlay'

/** Animate the available conversation width on both opening and closing; the border drags the width. */
export function ChatSidePanel({ open, width, onResize, children }: { open: boolean; width: number; onResize: (width: number) => void; children: ReactNode }) {
  // Animate explicit open/close actions without animating the initial mount.
  const { mounted, shown } = usePresence(open, 300, false)
  const last = useRef({ width, children })
  const dragStart = useRef<{ x: number; width: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  if (open) last.current = { width, children }
  const content = open ? { width, children } : last.current
  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStart.current = { x: e.clientX, width }
    setResizing(true)
  }
  const onMove = (e: React.PointerEvent) => {
    if (dragStart.current) onResize(dragStart.current.width + dragStart.current.x - e.clientX)
  }
  const onUp = () => {
    dragStart.current = null
    setResizing(false)
  }
  return (
    <div className={`side-panel ${shown ? 'shown' : ''} ${resizing ? 'resizing' : ''}`} inert={!open}
      style={{ width: shown ? content.width + 1 : 0 }}>
      {mounted ? <>
        <div className="side-panel-border" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          role="separator" aria-label="Resize panel" aria-valuenow={content.width} />
        <div style={{ width: content.width, height: '100%', flex: 'none' }}>{content.children}</div>
      </> : null}
    </div>
  )
}
