import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { CountBadge } from './Badges'
import './kith.css'

export type CrewBoard = 'crew' | 'board'

/** The segmented glass switch: Crew | Board. The Board count is an ink badge (16). */
export function CrewBoardSwitch({ value, onChange, boardCount = 0 }: { value: CrewBoard; onChange: (v: CrewBoard) => void; boardCount?: number }) {
  const items: [CrewBoard, string][] = [
    ['crew', 'Crew'],
    ['board', 'Board'],
  ]
  return (
    <div className="kc-switch kith-glass" role="tablist" aria-label="Crew or Board">
      {items.map(([id, label]) => (
        <button key={id} className={`kc-switch-item kith-text-top-bar ${value === id ? 'selected' : ''}`} role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {label}
          {id === 'board' ? <CountBadge count={boardCount} size={16} label={`${boardCount} on Board`} /> : null}
        </button>
      ))}
    </div>
  )
}

/** A round glass button (42) for the top bar. Icon-only, so `label` is its aria-label and tooltip. */
export function GlassButton({ label, icon, onClick, children }: { label: string; icon?: string; onClick?: () => void; children?: ReactNode }) {
  return (
    <button className="kc-glass-button kith-glass" aria-label={label} title={label} onClick={onClick}>
      {children ?? (icon ? <Icon name={icon} size={17} weight="medium" /> : null)}
    </button>
  )
}

/** The profile picture button: pass a SkyPatch or a photo as children. */
export const ProfileButton = ({ label = 'Profile', onClick, children }: { label?: string; onClick?: () => void; children: ReactNode }) => (
  <button className="kc-glass-button kc-profile kith-glass" aria-label={label} title={label} onClick={onClick}>
    {children}
  </button>
)

/** New chat: the square.and.pencil equivalent. */
export const NewChatButton = ({ onClick, label = 'New chat' }: { onClick?: () => void; label?: string }) => <GlassButton label={label} icon="square.and.pencil" onClick={onClick} />

/** Top bar text: Inter 600 16, never a large title. */
export const TopBarTitle = ({ children }: { children: ReactNode }) => <span className="kc-top-title kith-text-top-bar">{children}</span>
