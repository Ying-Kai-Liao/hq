import { statSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { prefs } from './host-controller'

// Codync Screen (capture + input for Remote screen): on macOS a launchd agent inside the app
// bundle (apps/screen-macos, registered through SMAppService), which owns the Screen Recording
// and Accessibility grants. Linux starts its helper from the host, so nothing happens here.

const serviceName = 'com.pokai.Codync.screen.plist'
const isMac = process.platform === 'darwin'

/** Identifies the helper binary inside this app: its path and modification date. */
function helperStamp() {
  const path = join(process.resourcesPath, '..', 'Library/LoginItems/CodyncScreen.app/Contents/MacOS/CodyncScreen')
  try {
    return `${path}@${statSync(path).mtimeMs}`
  } catch {
    return `${path}@0`
  }
}

function status(): string {
  if (!isMac || !app.isPackaged) return 'not-registered'
  return app.getLoginItemSettings({ type: 'agentService', serviceName }).status ?? 'not-registered'
}

/** Registers (or removes) the agent; returns whether macOS wants the user to allow it. */
export function setScreenAgent(on: boolean): { needsApproval: boolean } {
  if (!isMac || !app.isPackaged) return { needsApproval: false }
  app.setLoginItemSettings({ type: 'agentService', serviceName, openAtLogin: on })
  prefs.set('screenHelperStamp', on ? helperStamp() : null)
  return { needsApproval: status() === 'requires-approval' }
}

/**
 * Keeps Codync Screen registered while the host has Remote screen on, and registers it again
 * when this app ships a different helper binary (launchd keeps running the old one).
 */
export function syncScreenAgent(enabled: boolean): { needsApproval: boolean } {
  if (!isMac || !app.isPackaged || !enabled) return { needsApproval: false }
  const stale = prefs.get('screenHelperStamp') !== helperStamp()
  if (!stale && status() === 'enabled') return { needsApproval: false }
  if (stale && status() === 'enabled') app.setLoginItemSettings({ type: 'agentService', serviceName, openAtLogin: false })
  return setScreenAgent(true)
}

/** Before the app is replaced: the old helper stops along with its job. */
export function unregisterScreenAgent() {
  if (!isMac || !app.isPackaged || status() !== 'enabled') return
  app.setLoginItemSettings({ type: 'agentService', serviceName, openAtLogin: false })
  prefs.set('screenHelperStamp', null)
}

export function registerScreenIPC() {
  ipcMain.handle('screen:setAgent', (_e, on: boolean) => setScreenAgent(on))
  ipcMain.handle('screen:syncAgent', (_e, enabled: boolean) => syncScreenAgent(enabled))
}
