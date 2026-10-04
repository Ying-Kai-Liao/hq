import { EventEmitter } from 'node:events'
import { ipcMain, type BrowserWindow } from 'electron'
import type { AccountState } from '../shared/ipc'

/**
 * The Codync account: Clerk's sign-in (Apple, Google) through the system browser, with the
 * session kept in the OS keychain. An account session never grants access to a computer by
 * itself: each one still approves this device (spec §4.2).
 */
export class AccountService extends EventEmitter {
  state: AccountState = { ready: true, configured: false, busy: false, error: null, user: null, cloudURL: null }

  register(windows: () => BrowserWindow[]) {
    ipcMain.handle('account:state', () => this.state)
    ipcMain.handle('account:signIn', () => {
      this.set({ error: "Sign-in setup isn't finished yet. You can continue using local pairing." })
    })
    ipcMain.handle('account:signOut', () => {})
    ipcMain.handle('account:token', () => {
      throw new Error('Sign in again to reach your account.')
    })
    this.on('change', () => {
      for (const w of windows()) w.webContents.send('account:change', this.state)
    })
  }

  private set(change: Partial<AccountState>) {
    this.state = { ...this.state, ...change }
    this.emit('change')
  }
}
