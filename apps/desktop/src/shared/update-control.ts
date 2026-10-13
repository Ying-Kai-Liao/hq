import type { UpdateState } from './ipc'

/** What replaces Check for updates while a release is found, downloaded, or ready. */
export type UpdateControl =
  | { kind: 'progress'; percent: number }
  | { kind: 'restart' }
  | { kind: 'install'; version: string }
  | { kind: 'check' }

type UpdateSnapshot = Pick<UpdateState, 'downloadPercent' | 'staged' | 'autoDownload' | 'availableVersion' | 'supported'>

/** Progress wins, then Restart when a download is ready and automatic install is off. */
export function updateControl(state: UpdateSnapshot): UpdateControl {
  if (state.downloadPercent !== null) return { kind: 'progress', percent: state.downloadPercent }
  if (state.staged && !state.autoDownload) return { kind: 'restart' }
  if (state.availableVersion) return { kind: 'install', version: state.availableVersion }
  return { kind: 'check' }
}

/** Tray label. The menu is a system menu, so the percent is text rather than a capsule. */
export function updateMenuLabel(state: UpdateSnapshot): string {
  const control = updateControl(state)
  switch (control.kind) {
    case 'progress':
      return `Downloading ${control.percent}%…`
    case 'restart':
      return 'Restart to Update…'
    case 'install':
      return `Update to ${control.version}…`
    case 'check':
      return 'Check for Updates…'
  }
}

/** A download in progress is not clickable. A staged release can still restart. */
export function updateMenuEnabled(state: UpdateSnapshot): boolean {
  if (state.downloadPercent !== null) return false
  return state.supported || state.staged
}
