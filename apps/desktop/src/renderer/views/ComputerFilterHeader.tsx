import type { Computer } from '@shared/models'
import { DropdownMenu } from '../components/Controls'
import { Icon } from '../components/Icon'
import type { MenuItem } from '../components/Overlay'
import { font } from '../lib/fonts'
import { useApp } from '../store/context'
import type { Connection } from '../store/bot-store'

/** An empty exclusion list means all computers, including newly paired ones. */
export function computerSelection(all: string[], hidden: string) {
  const excluded = new Set(hidden.split(',').filter(Boolean))
  const visible = all.filter((id) => !excluded.has(id))
  const shown = visible.length ? visible : all
  const encoded = (ids: Set<string>) => [...ids].sort().join(',')
  return {
    shown,
    toggling(id: string) {
      if (!all.includes(id)) return encoded(new Set(all.filter((x) => !shown.includes(x))))
      const next = new Set(shown)
      if (next.has(id)) {
        if (next.size > 1) next.delete(id)
      } else next.add(id)
      return encoded(new Set(all.filter((x) => !next.has(x))))
    },
    only(id: string) {
      return all.includes(id) ? encoded(new Set(all.filter((x) => x !== id))) : ''
    },
  }
}

function summary(connections: Connection[]) {
  if (!connections.length) return 'Computers'
  const online = connections.filter((c) => c.kind === 'online').length
  if (online === connections.length) return `${online} connected`
  if (online > 0) return `${online}/${connections.length} connected`
  if (connections.some((c) => c.kind === 'connecting')) return 'Connecting…'
  if (connections.every((c) => c.kind === 'unauthorized')) return 'No access'
  if (connections.every((c) => c.kind === 'unpaired')) return 'Not paired'
  return `${connections.length} offline`
}

/** The roster's only connection surface: a quiet summary, with details and filters on demand. */
export function ComputerFilterHeader({ hidden, setHidden, manage, compact = false }: { hidden: string; setHidden: (v: string) => void; manage: () => void; compact?: boolean }) {
  const app = useApp()
  const selection = computerSelection(app.computers.map((c) => c.id), hidden)
  const stores = selection.shown.map((id) => app.store(id)).filter((s) => !!s)
  const text = summary(stores.map((s) => s.shownConnection))
  const title = (c: Computer) => {
    const store = app.store(c.id)
    return store ? `${store.hostName} · ${store.connectionLabel}` : c.name
  }
  const items = (): MenuItem[] => {
    const list: MenuItem[] = [{ title: 'All computers', selected: selection.shown.length === app.computers.length, action: () => setHidden('') }]
    for (const c of app.computers) list.push({ title: title(c), selected: selection.shown.includes(c.id), action: () => setHidden(selection.toggling(c.id)) })
    if (app.computers.length > 1) app.computers.forEach((c, i) => list.push({ title: `Only ${c.name}`, divider: i === 0, action: () => setHidden(selection.only(c.id)) }))
    if (stores.length) list.push({ title: 'Reconnect', icon: 'arrow.clockwise', divider: true, action: () => stores.forEach((s) => s.restartStream()) })
    list.push({ title: 'Manage computers', icon: 'desktopcomputer', action: manage })
    return list
  }
  return (
    <DropdownMenu items={items} title={text} className={compact ? 'computer-filter-action' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: compact ? '0 9px' : '6px 0', ...font(12, 'medium'), color: 'var(--secondary)' }}>
      {compact ? <Icon name="desktopcomputer" size={12} weight="medium" /> : <span style={{ whiteSpace: 'nowrap' }} aria-label={`Computers, ${text}. Filter conversations`}>{text}</span>}
      <Icon name="chevron.down" size={8} weight="semibold" />
    </DropdownMenu>
  )
}
