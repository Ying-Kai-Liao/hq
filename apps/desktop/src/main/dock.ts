import { app } from 'electron'
import { prefs } from './host-controller'

export const showInDock = () => prefs.get('showInDock') === true

export function setShowInDock(on: boolean) {
  prefs.set('showInDock', on)
  applyDockVisibility()
  return showInDock()
}

export function applyDockVisibility() {
  if (process.platform !== 'darwin') return
  if (showInDock()) void app.dock?.show()
  else app.dock?.hide()
}
