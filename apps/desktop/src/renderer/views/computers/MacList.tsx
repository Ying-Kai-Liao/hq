import { useEffect } from 'react'
import { Button } from '../../components/Controls'
import { Spacer } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { useAccount } from '../../store/account'
import { useApp } from '../../store/context'
import { macRows, spaced, type MacRow } from '../../store/mac-list'
import { ComputerBadge } from '../ComputerBadge'
import { useSSH } from '../settings/ssh-model'

/**
 * Every Mac this account can use: this computer, SSH computers, and the Macs it owns or has joined over the Kith cloud,
 * each with its state, the account's role on it and what can be done. Self-contained, so a profile page can mount it as is.
 */
export function MacList() {
  const app = useApp()
  const account = useAccount()
  const ssh = useSSH()
  const macs = useModel(app.relayMacs)
  useEffect(() => void macs.refresh(), [macs, account.user?.userId])
  const rows = macRows(app, (id) => ssh.isSSH(id))
  if (!account.isSignedIn && rows.length === 0) return <Text as="div" size="callout" tone="secondary">Sign in to reach your other Macs.</Text>
  return (
    <>
      {macs.error ? <Text as="div" size="caption" tone="attention">{macs.error}</Text> : null}
      {rows.map((row) => <MacRowView key={row.id} row={row} />)}
      {macs.loaded && rows.length === 0 ? <Text as="div" size="callout" tone="secondary">No Macs yet.</Text> : null}
    </>
  )
}

function MacRowView({ row }: { row: MacRow }) {
  const macs = useApp().relayMacs
  return (
    <div className="settings-card settings-appear">
      <div className="settings-row">
        <ComputerBadge computer={row.computer} size={22} />
        <div className="settings-stack">
          <Text size="callout" weight="medium">{row.name}</Text>
          <Text size="caption" tone="secondary">{`${row.roleLabel} · ${row.online ? 'Online' : 'Offline'} · ${row.status}`}</Text>
        </div>
        <Spacer />
        {row.code ? <Text size="headline" mono aria-label={`Digits to check: ${row.code}`}>{spaced(row.code)}</Text> : null}
        {row.action === 'connect' ? <Button kind="secondary" onClick={() => void macs.connect(row.id)}>Connect</Button> : null}
        {row.action === 'cancel' ? <Button kind="secondary" onClick={() => macs.cancel(row.id)}>Cancel</Button> : null}
        {row.action === 'disconnect' ? <Button kind="secondary" onClick={() => void macs.disconnect(row.id)}>Disconnect</Button> : null}
        {row.action === 'forget' ? <Button kind="secondary" onClick={() => void macs.disconnect(row.id)}>Forget</Button> : null}
      </div>
    </div>
  )
}
