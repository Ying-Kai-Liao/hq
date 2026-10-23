import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, safeStorage } from 'electron'
import { parseInviteLink, type InviteLink } from '../shared/invite'

/**
 * Invite links (`kith://invite?...`). The link's token t is a secret for the owner's Mac only: it is held here
 * until the window takes it, kept encrypted per computer so a reconnect can prove again, and never logged.
 */

const CANT_STORE = "Can't store the invite safely on this computer."

let pending: InviteLink | null = null
let notify: (() => void) | null = null

/** The window to nudge when a link arrives. */
export function onInviteLink(cb: () => void) {
  notify = cb
  if (pending) cb()
}

/** Takes the link if `url` is an invite. */
export function handleInviteURL(url: string, schemes: readonly string[]): boolean {
  const link = parseInviteLink(url, schemes)
  if (!link) return false
  pending = link
  notify?.()
  return true
}

const vaultPath = () => join(app.getPath('userData'), 'invite-tokens.bin')

type Vault = Record<string, { inviteId: string; token: string }>

async function readVault(): Promise<Vault> {
  try {
    const raw = await fs.readFile(vaultPath())
    return JSON.parse(safeStorage.decryptString(raw)) as Vault
  } catch {
    return {}
  }
}

async function writeVault(vault: Vault) {
  // Never in plaintext: without the OS keychain the token isn't kept at all.
  if (!safeStorage.isEncryptionAvailable()) throw new Error(CANT_STORE)
  const text = JSON.stringify(vault)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(vaultPath(), safeStorage.encryptString(text), { mode: 0o600 })
}

export function registerInviteIPC() {
  ipcMain.handle('invite:takePending', () => {
    const link = pending
    pending = null
    return link
  })
  ipcMain.handle('invite:keep', async (_e, computerId: string, inviteId: string, token: string) => {
    const vault = await readVault()
    vault[computerId] = { inviteId, token }
    await writeVault(vault)
  })
  ipcMain.handle('invite:kept', async (_e, computerId: string) => (await readVault())[computerId] ?? null)
  // Whether a token is kept, without the token itself reaching a window.
  ipcMain.handle('invite:has', async (_e, computerId: string) => computerId in (await readVault()))
  ipcMain.handle('invite:forget', async (_e, computerId: string) => {
    const vault = await readVault()
    delete vault[computerId]
    await writeVault(vault)
  })
}
