import { roleLabel, type MacRole } from '@shared/mac-role'
import type { Computer } from '@shared/models'
import { OPEN_INVITE_LINK } from './relay-macs'
import type { AppModel } from './app-model'
import type { BotStore } from './bot-store'

/** One Mac in the list: what it is called, whether it is up, what this account is on it, and what can be done. */
export interface MacRow {
  id: string
  /** this computer's own host, an SSH computer, or a Mac over the cloud */
  kind: 'this' | 'ssh' | 'relay'
  computer: Computer
  name: string
  online: boolean
  role: MacRole
  roleLabel: string
  status: string
  /** Six digits to compare with the ones on the Mac (an owner's own Mac only). */
  code: string | null
  /** connect: no channel yet · cancel: asking · disconnect: connected, or access removed (forget) · none: always there */
  action: 'connect' | 'cancel' | 'disconnect' | 'forget' | 'none'
  busy: boolean
}

const relayStatus = (store: BotStore) => {
  const c = store.shownConnection
  switch (c.kind) {
    case 'online':
      return store.mismatch ? 'Needs update' : 'Connected'
    case 'connecting':
      return 'Connecting…'
    case 'computerOffline':
    case 'offline':
      // The words of a refusal (a key that doesn't match, an invite not shown yet) beat a bare "offline".
      return c.kind === 'offline' && c.message === OPEN_INVITE_LINK ? c.message : 'Offline'
    case 'unauthorized':
      return 'Access removed'
    case 'unpaired':
      return 'Not paired'
  }
}

/** Every Mac this account can use, in one list: this computer, SSH computers, and the account's owned and joined Macs. */
export function macRows(app: AppModel, isSSH: (id: string) => boolean): MacRow[] {
  const rows: MacRow[] = []
  const managed = new Set<string>()
  for (const store of app.managedStores) {
    managed.add(store.computer.id)
    rows.push({
      id: store.computer.id,
      kind: isSSH(store.computer.id) ? 'ssh' : 'this',
      computer: store.computer,
      name: store.hostName,
      online: store.connection.kind === 'online',
      role: 'owner',
      roleLabel: roleLabel('owner'),
      status: store.connectionLabel,
      code: null,
      action: 'none',
      busy: false,
    })
  }
  const macs = app.relayMacs
  for (const c of macs.computers) {
    if (managed.has(c.computerId)) continue
    const store = macs.store(c.computerId)
    const access = macs.access.get(c.computerId)
    const role = macs.roleOf(c.computerId)
    let status = c.online ? 'Online' : 'Offline'
    let action: MacRow['action'] = 'connect'
    let code: string | null = null
    if (store) {
      status = relayStatus(store)
      action = store.connection.kind === 'unauthorized' ? 'forget' : 'disconnect'
    } else if (access?.kind === 'asking') {
      status = 'Asking the Mac…'
      action = 'cancel'
    } else if (access?.kind === 'code') {
      status = access.compare ? 'Check these digits on the Mac' : 'Waiting for the Mac to approve'
      code = access.compare ? access.code : null
      action = 'cancel'
    } else if (access?.kind === 'failed') {
      status = access.message
    }
    rows.push({
      id: c.computerId,
      kind: 'relay',
      computer: { id: c.computerId, name: c.name, signKey: c.signKey, urls: [], device: c.platform === 'linux' ? 'linux' : null },
      name: store?.hostName ?? c.name,
      online: store ? store.connection.kind === 'online' : c.online,
      role,
      roleLabel: roleLabel(role),
      status,
      code,
      action,
      busy: access?.kind === 'asking' || access?.kind === 'code',
    })
  }
  return rows
}

/** "123 456" for the six digits. */
export const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code)
