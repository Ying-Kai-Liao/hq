import type { VersionMismatch } from '@shared/compat'
import { Button } from '../components/Controls'
import { Icon } from '../components/Icon'
import { font } from '../lib/fonts'
import { useApp, useStore } from '../store/context'

/** The words every client uses for a version mismatch (iOS, the TUI and this app). */
export const updateNeededText = {
  title(m: VersionMismatch, host: string) {
    return m.kind === 'updateApp' ? 'Update this app' : `Update Codync on ${host}`
  },
  detail(m: VersionMismatch, host: string, hostVersion: string | null | undefined, os: string | null | undefined, instructions = true) {
    if (m.kind === 'updateApp') {
      const runs = hostVersion ? `${host} runs Codync ${hostVersion} and` : host
      return `${runs} needs this app to be ${m.minimum} or newer. Your chats are safe on the computer.`
    }
    const how =
      os === 'macos' ? 'Open Codync on that Mac and choose Check for Updates.'
      : os === 'linux' ? 'Run codync-host update there, or use Check for updates in its Codync app.'
      : 'Update Codync on that computer.'
    const needs = `${host} runs Codync ${m.version}; this app needs ${m.minimum} or newer.`
    return instructions ? `${needs} ${how}` : needs
  },
}

/**
 * Says which side has to update before this app and a computer can work together, and offers
 * the update where this app can start it. Shown instead of the composer and above the bots.
 */
export function UpdateNeededCard() {
  const app = useApp()
  const store = useStore()
  const mismatch = store.mismatch
  if (!mismatch) return null
  // This app updates itself; this computer's own host is put back on the app's bundled copy.
  const action: [string, () => void] | null =
    mismatch.kind === 'updateApp'
      ? ['Update Codync', () => window.codync.updates.check()]
      : store === app.local && !app.host.dev
        ? [`Update ${store.hostName}`, () => window.codync.host.restart()]
        : null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14, background: 'var(--surface)', borderRadius: 16 }}>
      <Icon name="arrow.down.circle" size={15} color="var(--warning)" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <div style={{ ...font('subheadline', 'semibold'), color: 'var(--text)' }}>{updateNeededText.title(mismatch, store.hostName)}</div>
        <div style={{ ...font('footnote'), color: 'var(--secondary)' }}>
          {updateNeededText.detail(mismatch, store.hostName, store.hostVersion?.version, store.hello?.os, action === null)}
        </div>
        {action ? (
          <Button onClick={action[1]} style={{ marginTop: 4, alignSelf: 'flex-start' }}>
            {action[0]}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
