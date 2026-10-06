import { useRef, type ReactNode } from 'react'
import { usePresence } from '../../components/Overlay'

/** Animate the available conversation width on both opening and closing. */
export function ChatSidePanel({ open, width, children }: { open: boolean; width: number; children: ReactNode }) {
  // A new bot mounts a fresh conversation with details already open.
  // Only subsequent open/close actions should animate the available width.
  const { mounted, shown } = usePresence(open, 300, false)
  const last = useRef({ width, children })
  if (open) last.current = { width, children }
  const content = open ? { width, children } : last.current
  return (
    <div className={`side-panel ${shown ? 'shown' : ''}`} inert={!open}
      style={{ width: shown ? content.width + 1 : 0 }}>
      {mounted ? <>
        <div className="side-panel-border" />
        <div style={{ width: content.width, height: '100%', flex: 'none' }}>{content.children}</div>
      </> : null}
    </div>
  )
}
