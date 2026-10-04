import { EventEmitter } from 'node:events'
import { app, ipcMain, type BrowserWindow } from 'electron'
import type { UpdateState } from '../shared/ipc'

/** The app's own updates. Release builds only. */
export class Updates extends EventEmitter {
  state: UpdateState = {
    supported: app.isPackaged,
    canCheck: app.isPackaged,
    checking: false,
    availableVersion: null,
    staged: false,
    autoCheck: true,
    autoDownload: true,
    lastCheck: null,
    error: null,
    waitingForApp: null,
  }

  register(windows: () => BrowserWindow[]) {
    ipcMain.handle('updates:state', () => this.state)
    ipcMain.on('updates:check', () => this.check())
    ipcMain.on('updates:autoCheck', (_e, on: boolean) => this.set({ autoCheck: on }))
    ipcMain.on('updates:autoDownload', (_e, on: boolean) => this.set({ autoDownload: on }))
    this.on('change', () => {
      for (const w of windows()) w.webContents.send('updates:change', this.state)
    })
  }

  check() {}

  protected set(change: Partial<UpdateState>) {
    this.state = { ...this.state, ...change }
    this.emit('change')
  }
}
