import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/ipc'
import { updateAction } from '@shared/update-action'
import { Button } from '../components/Controls'
import { Icon } from '../components/Icon'
import { Dialog } from '../components/Overlay'

/** The app's update state, kept live. */
export function useUpdates() {
  const [updates, setUpdates] = useState<UpdateState | null>(null)
  useEffect(() => {
    void window.codync.updates.state().then(setUpdates)
    return window.codync.updates.onChange(setUpdates)
  }, [])
  return updates
}

/** Check, update, download progress, then Restart to update: whatever the update state offers. */
export function UpdateButton({ updates, kind = 'secondary' }: { updates: UpdateState; kind?: 'primary' | 'secondary' }) {
  const action = updateAction(updates)
  return (
    <Button kind={updates.staged ? 'primary' : kind} onClick={() => window.codync.updates.check()} disabled={!action.enabled}>
      {action.label}
    </Button>
  )
}

/** The sidebar's nudge while a release is available: Update, once confirmed, restarts into it. */
export function UpdateBadge({ size }: { size: number }) {
  const updates = useUpdates()
  const [confirming, setConfirming] = useState(false)
  if (!updates?.supported || !updates.availableVersion || updates.waitingForApp) return null
  return (
    <>
      <button
        className="update-badge"
        style={{ width: size, height: size }}
        title="Update"
        aria-label="Update"
        disabled={updates.installing}
        onClick={() => setConfirming(true)}
      >
        <Icon name="arrow.down" size={size * 0.42} weight="semibold" />
      </button>
      <Dialog
        open={confirming}
        title={`Update to Codync ${updates.availableVersion}?`}
        message="Codync restarts to install it."
        actions={[{ title: 'Update', action: () => window.codync.updates.install() }]}
        onClose={() => setConfirming(false)}
      />
    </>
  )
}
