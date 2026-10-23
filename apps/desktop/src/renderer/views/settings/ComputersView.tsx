import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { AccountApproval, AuthorizedDevice, PairingInfo } from '@shared/models'
import { newSSHProfile, type SSHProfile } from '@shared/ssh'
import { Button, CardSection, IconButton, Spinner, Switch } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { AnchoredMenu, Dialog, ModalHeader, Sheet, useContextMenu, useDismiss, type MenuItem } from '../../components/Overlay'
import { HStack, IconSlot, Spacer, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { prefs, usePref } from '../../lib/prefs'
import { useAccount } from '../../store/account'
import type { BotStore } from '../../store/bot-store'
import { StoreContext, useApp } from '../../store/context'
import { macRows, spaced, type MacRow } from '../../store/mac-list'
import { ComputerBadge } from '../ComputerBadge'
import { computerSelection } from '../ComputerFilterHeader'
import { deviceIcon, errorText, liveClient, relativeDay, Reveal, thisMac } from './parts'
import { useSSH } from './ssh-model'
import { SSHRow } from './SSHRow'
import { BackupChains } from './BackupChain'
import { VoiceChatSettingsView } from './VoiceChatSettingsView'
import '../pairing-window.css'

/**
 * Settings > Computers: every computer this account can use with its Show in Crew switch, then what this Mac
 * offers (reach from anywhere, pairing, devices), SSH computers, and the account's other Macs (ask for access).
 */
export function ComputersView() {
  const app = useApp()
  const account = useAccount()
  const sshState = useSSH()
  const macs = useModel(app.relayMacs)
  useEffect(() => void macs.refresh(), [macs, account.user?.userId])
  const [editing, setEditing] = useState<{ profile: SSHProfile; isNew: boolean } | null>(null)
  const [panel, setPanel] = useState<{ kind: 'voice' | 'backups'; store: BotStore } | null>(null)
  const [hidden, setHidden] = usePref(prefs.hiddenComputers)
  const rows = macRows(app, (id) => sshState.isSSH(id))
  const selection = computerSelection(app.computers.map((c) => c.id), hidden)

  return (
    <>
      <CardSection title="Computers" accessory={<span className="settings-section-note">Show in Crew</span>}>
        {rows.length === 0
          ? [<Text key="none" tone="secondary">{account.isSignedIn ? (macs.loaded ? 'No computers yet.' : 'Looking for your computers…') : 'Sign in to reach your other Macs.'}</Text>]
          : rows.map((row) => (
              <ComputerRow
                key={row.id}
                row={row}
                shown={selection.shown.includes(row.id)}
                onShow={() => setHidden(selection.toggling(row.id))}
                openPanel={(kind, store) => setPanel({ kind, store })}
              />
            ))}
      </CardSection>
      {macs.error ? <Text as="div" size="caption" tone="attention">{macs.error}</Text> : null}

      {app.managedStores.map((store) => (
        <ManagedComputerCard key={store.computer.id} store={store} ssh={sshState.isSSH(store.computer.id)} />
      ))}

      <CardSection
        title="Over SSH"
        accessory={<IconButton title="Add SSH computer" icon="plus" onClick={() => setEditing({ profile: newSSHProfile(window.kith.hostPort), isNew: true })} />}
        footer={`Run bots on another computer you reach with SSH. It needs kith-serve installed; your SSH keys stay on ${thisMac}.`}
      >
        {sshState.state.profiles.length === 0
          ? [<Text key="none" tone="secondary">No SSH computers.</Text>]
          : sshState.state.profiles.map((profile) => (
              <SSHRow key={profile.id} profile={profile} status={sshState.status(profile.id)} edit={() => setEditing({ profile, isNew: false })} />
            ))}
      </CardSection>
      <Text as="div" size="caption" tone="secondary" className="settings-hint">
        Right-click a computer: Voice chat, Backups, Disconnect.
      </Text>

      <Sheet className="settings-sheet" open={editing !== null} onClose={() => setEditing(null)} width={460}>
        {editing ? <SSHProfileEditor key={editing.profile.id} profile={editing.profile} isNew={editing.isNew} /> : null}
      </Sheet>
      <Sheet className="settings-sheet" open={panel !== null} onClose={() => setPanel(null)}>
        {panel ? (
          <StoreContext.Provider value={panel.store}>
            {panel.kind === 'voice' ? <VoiceChatSettingsView /> : <BackupsSheet store={panel.store} />}
          </StoreContext.Provider>
        ) : null}
      </Sheet>
    </>
  )
}

function BackupsSheet({ store }: { store: BotStore }) {
  return (
    <div className="settings-sheet-body">
      <ModalHeader title={`Backups on ${store.hostName}`} />
      <div className="settings-devices-body">
        <BackupChains only={store.computer.id} />
      </div>
    </div>
  )
}

/** One computer: its badge, route and bots, the Show in Crew switch (or the way to ask for access), and its right-click menu. */
function ComputerRow({ row, shown, onShow, openPanel }: {
  row: MacRow
  shown: boolean
  onShow: () => void
  openPanel: (kind: 'voice' | 'backups', store: BotStore) => void
}) {
  const app = useApp()
  const macs = app.relayMacs
  const store = app.store(row.id)
  useModel(store ?? null)
  const menu = useContextMenu()
  const route = row.kind === 'relay' ? 'Cloudflare' : row.kind === 'ssh' ? 'SSH' : store?.cloud?.enabled && store.cloud.connected ? 'Wi-Fi · reach from anywhere on' : 'Wi-Fi'
  const bots = store ? `${store.roster.length} bot${store.roster.length === 1 ? '' : 's'} · ` : ''
  const sub = row.kind === 'relay' && !store ? `in your account · ${row.status.toLowerCase()}` : `${bots}${route}${row.online ? '' : ` · ${row.status.toLowerCase()}`}`
  const items = (): MenuItem[] => [
    ...(store && row.online
      ? [
          { title: 'Voice chat', icon: 'waveform', action: () => openPanel('voice', store) },
          { title: 'Backups', icon: 'arrow.triangle.2.circlepath', action: () => openPanel('backups', store) },
        ]
      : []),
    ...(row.kind === 'relay' && (row.action === 'disconnect' || row.action === 'forget')
      ? [{ title: row.action === 'forget' ? 'Forget' : 'Disconnect', icon: 'xmark.circle', destructive: true, divider: !!store && row.online, action: () => void macs.disconnect(row.id) }]
      : []),
  ]
  const hasMenu = items().length > 0
  const hasSwitch = store !== undefined && row.action !== 'forget'
  return (
    <div className="settings-computer" onContextMenu={hasMenu ? menu.onContextMenu : undefined}>
      <ComputerBadge computer={row.computer} size={28} />
      <VStack grow className="settings-stack">
        <Text tone="text" truncate>{row.name}{row.kind === 'this' ? ` · ${thisMac}` : ''}</Text>
        <Text size="caption" tone="secondary" truncate>{sub}</Text>
      </VStack>
      {row.code ? <Text size="headline" mono aria-label={`Digits to check: ${row.code}`}>{spaced(row.code)}</Text> : null}
      {row.action === 'connect' ? <Button kind="secondary" onClick={() => void macs.connect(row.id)}>Ask for access</Button> : null}
      {row.action === 'cancel' ? <Button kind="secondary" onClick={() => macs.cancel(row.id)}>Cancel</Button> : null}
      {row.action === 'forget' ? <Button kind="secondary" onClick={() => void macs.disconnect(row.id)}>Forget</Button> : null}
      {hasSwitch ? <Switch className="bare" on={shown} onChange={onShow} label={`Show ${row.name} in Crew`} /> : null}
      <AnchoredMenu open={menu.open} onClose={menu.close} point={menu.point} items={items} />
    </div>
  )
}

const isMacLabel = thisMac === 'this Mac' ? 'This Mac' : 'This computer'

/** This computer or an SSH computer: relay, account membership, pairing and authorized devices. */
function ManagedComputerCard({ store, ssh: overSSH }: { store: BotStore; ssh: boolean }) {
  const app = useApp()
  const account = useAccount()
  useModel(store)
  const [devices, setDevices] = useState<AuthorizedDevice[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPairing, setShowPairing] = useState(false)
  const [showDevices, setShowDevices] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<AuthorizedDevice | null>(null)
  const [confirmUnclaim, setConfirmUnclaim] = useState(false)
  const [confirmAutoApproval, setConfirmAutoApproval] = useState(false)
  const cloud = store.cloud
  const autoApproval = cloud?.approval === 'auto'
  const online = store.connection.kind === 'online'
  const name = store.hostName
  const requests = store.accessRequests.length

  const run = (work: () => Promise<void>) => {
    setBusy(true)
    void work().finally(() => setBusy(false))
  }

  const loadDevices = useCallback(async () => {
    const client = liveClient(store)
    if (!client) return
    try {
      setDevices((await client.call<{ devices: AuthorizedDevice[] }>('devices')).devices)
    } catch {}
  }, [store])

  useEffect(() => void loadDevices(), [loadDevices, online, store.accessRequests.length])

  const setApproval = (approval: AccountApproval) =>
    run(async () => {
      try {
        await (await store.ready()).call('setApproval', { approval })
      } catch (e) {
        store.setError(errorText(e))
      }
    })

  const cloudLine = !cloud?.enabled
    ? 'Off: only Wi-Fi and Tailscale reach it, nothing goes through Cloudflare.'
    : (cloud.lastError ?? (cloud.connected ? 'Relay connected: reachable from anywhere through Cloudflare (encrypted).' : 'Connecting to Cloudflare…'))

  const owner = cloud?.owner ?? null
  const accountLine = (
    <HStack gap={8} className="settings-row">
      <Icon name={owner ? 'person.crop.circle.badge.checkmark' : 'person.crop.circle.badge.plus'} size={13} color="var(--secondary)" />
      <Text size="callout" grow>
        {owner
          ? owner.userId === account.user?.userId
            ? 'In your account'
            : `In ${owner.email ?? 'another'} account`
          : account.isSignedIn
            ? 'Not in your account'
            : 'Sign in to add it to your account'}
      </Text>
      {owner ? (
        <Button kind="secondary" onClick={() => setConfirmUnclaim(true)} disabled={busy || !online}>
          Remove from account
        </Button>
      ) : account.isSignedIn ? (
        <Button kind="secondary" onClick={() => run(async () => void (await app.cloud.claim(store)))} disabled={busy || !online}>
          {busy ? 'Adding…' : 'Add to account'}
        </Button>
      ) : null}
    </HStack>
  )

  const deviceNames = devices?.map((d) => d.name).join(', ')
  return (
    <>
      <CardSection title={overSSH ? `${name} · over SSH` : isMacLabel}>
        {[
          <Switch key="cloud" on={cloud?.enabled ?? false} disabled={busy || !online} onChange={(on) => run(() => app.cloud.setCloud(store, on))}>
            <span className="settings-stack">
              <span>Reach from anywhere</span>
              <Text size="caption" tone={cloud?.lastError ? 'attention' : 'secondary'}>{cloudLine}</Text>
            </span>
          </Switch>,
          <div key="pair" className="settings-row">
            <VStack grow className="settings-stack">
              <span>Pair iPhone</span>
              <Text size="caption" tone="secondary">show a one-time code</Text>
            </VStack>
            <Button kind="secondary" disabled={!online} onClick={() => setShowPairing(true)}>Show code</Button>
          </div>,
          <button key="devices" className="settings-row settings-nav-row" onClick={() => setShowDevices(true)}>
            <VStack grow className="settings-stack">
              <span>Devices that can use {name}</span>
              <Text size="caption" tone="secondary" truncate>
                {devices === null ? 'Loading…' : `${deviceNames || 'None yet'}${requests > 0 ? ` · ${requests} request${requests === 1 ? '' : 's'}` : ''}`}
              </Text>
            </VStack>
            {requests > 0 ? <span className="settings-count">{requests}</span> : null}
            <Icon name="chevron.right" size={11} color="var(--secondary)" />
          </button>,
          accountLine,
          ...(owner
            ? [
                <Switch
                  key="approval"
                  on={autoApproval}
                  disabled={busy || !online}
                  onChange={(on) => (on ? setConfirmAutoApproval(true) : setApproval('code'))}
                >
                  <span className="settings-stack settings-appear">
                    <span>Skip the 6-digit check</span>
                    <Text size="caption" tone={autoApproval ? 'attention' : 'secondary'}>
                      {autoApproval ? 'Devices on your account get in on their own.' : 'Each new device shows a code you approve here.'}
                    </Text>
                  </span>
                </Switch>,
              ]
            : []),
        ]}
      </CardSection>

      <Sheet className="settings-sheet" open={showDevices} onClose={() => setShowDevices(false)} width={460}>
        <ModalHeader title={`Devices that can use ${name}`} />
        <div className="settings-devices-body">
          <CardSection>
            {devices === null
              ? [<Spinner key="loading" />]
              : [
                  ...(requests > 0
                    ? [
                        <div key="requests" className="settings-row">
                          <Text grow>{requests} access request{requests === 1 ? '' : 's'} waiting</Text>
                          <Button onClick={() => { app.reviewApprovals(); setShowDevices(false) }}>Review</Button>
                        </div>,
                      ]
                    : []),
                  ...(devices.length === 0
                    ? [<Text key="none" tone="secondary">None yet. Pair an iPhone, or approve one from your account.</Text>]
                    : []),
                  ...devices.map((device) => (
                    <HStack key={device.key} gap={8} className="settings-row settings-appear">
                      <IconSlot width={18} tone="secondary">
                        <Icon name={deviceIcon(device.platform)} size={13} />
                      </IconSlot>
                      <VStack grow className="settings-stack">
                        <span>{device.name}</span>
                        <Text size="caption" tone="tertiary">{deviceDetail(device)}</Text>
                      </VStack>
                      <Button kind="secondary" onClick={() => setConfirmRevoke(device)}>Revoke</Button>
                    </HStack>
                  )),
                ]}
          </CardSection>
        </div>
      </Sheet>
      <Sheet className="settings-sheet" open={showPairing} onClose={() => setShowPairing(false)} width={340}>
        <ModalHeader title={`Pair iPhone with ${name}`} />
        <PairingPanel store={store} />
      </Sheet>
      <Dialog
        open={confirmRevoke !== null}
        title={`Revoke ${confirmRevoke?.name ?? 'device'}?`}
        message="It disconnects right away and has to pair or ask again."
        actions={
          confirmRevoke
            ? [{
                title: 'Revoke access',
                destructive: true,
                action: () =>
                  run(async () => {
                    try {
                      await (await store.ready()).call('revokeDevice', { key: confirmRevoke.key })
                    } catch (e) {
                      store.setError(errorText(e))
                    }
                    await loadDevices()
                  }),
              }]
            : []
        }
        onClose={() => setConfirmRevoke(null)}
      />
      <Dialog
        open={confirmAutoApproval}
        title="Let account devices in without a code?"
        message={`Any device signed in to your account gets full control of ${name}: its files, terminals and bots, with no check here. If someone gets into your account, or Kith's cloud is ever compromised, they could add their own device and you'd have no chance to stop it. Devices paired with a QR code aren't affected.`}
        actions={[{ title: 'Skip the check', destructive: true, action: () => setApproval('auto') }]}
        onClose={() => setConfirmAutoApproval(false)}
      />
      <Dialog
        open={confirmUnclaim}
        title={`Remove ${name} from the account?`}
        message="Devices that were approved through the account lose access. Devices paired with a QR code keep it."
        actions={[{ title: 'Remove from account', destructive: true, action: () => run(() => app.cloud.unclaim(store)) }]}
        onClose={() => setConfirmUnclaim(false)}
      />
    </>
  )
}

function deviceDetail(device: AuthorizedDevice) {
  const parts = [device.source === 'account' ? 'Approved through the account' : 'Paired with a QR code']
  if (device.connected) parts.push('connected')
  else if (device.lastSeenAt) parts.push(`seen ${relativeDay(new Date(device.lastSeenAt))}`)
  return parts.join(' · ')
}

/** A one-time pairing QR (v3) from a computer this app manages: its keys, a code, and how to reach it. */
function PairingPanel({ store }: { store: BotStore }) {
  useModel(store)
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = store.hostName

  const load = useCallback(async () => {
    const client = liveClient(store)
    if (!client) return setError(`${store.hostName} isn't connected.`)
    try {
      const pairing = await client.call<PairingInfo>('pairing')
      setQr(await QRCode.toDataURL(pairing.pairingUrl, { errorCorrectionLevel: 'M', margin: 0, width: 400, color: { dark: '#000000', light: '#ffffff' } }))
      setInfo(pairing)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [store])

  useEffect(() => void load(), [load])
  // A fresh code when this one expires while it's on screen.
  useEffect(() => {
    if (!info?.expiresAt) return
    const timer = setTimeout(() => void load(), Math.max(1000, info.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [info?.expiresAt, load])

  return (
    <VStack align="center" gap={12} className="settings-pairing">
      {info && qr ? (
        <>
          <div className="pairing-qr settings-appear">
            <img src={qr} alt={`Pairing code for ${name}`} width={200} height={200} />
          </div>
          <Text as="div" size="caption" tone="secondary" className="settings-centered">
            Scan with the Kith app or the iPhone Camera. No Tailscale or open ports needed: your iPhone connects directly on the same Wi-Fi, and through the encrypted relay anywhere else.
          </Text>
          {store.cloud?.enabled !== true ? (
            <Text as="div" size="caption" tone="attention" className="settings-centered">
              {info.urls.length === 0
                ? 'No network address found and “Reach from anywhere” is off. Connect to Wi-Fi or turn it on.'
                : `“Reach from anywhere” is off, so the iPhone only reaches ${name} on the same network.`}
            </Text>
          ) : null}
          <HStack gap={4}>
            {info.expiresAt ? (
              <Text size="caption2" tone="tertiary">
                Works once, until {new Date(info.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </Text>
            ) : null}
            <IconButton title="New code" icon="arrow.clockwise" onClick={() => void load()} />
            <IconButton title="Copy pairing link" icon="doc.on.doc" onClick={() => window.kith.app.copy(info.pairingUrl)} />
          </HStack>
        </>
      ) : error ? (
        <>
          <Text as="div" size="caption" tone="danger" className="settings-centered">{error}</Text>
          <IconButton title="Try again" icon="arrow.clockwise" onClick={() => void load()} />
        </>
      ) : (
        <Spinner size={20} />
      )}
    </VStack>
  )
}
// MARK: SSH

/** Add or change an SSH computer. Only fields ssh takes as separate arguments; nothing goes through a shell. */
function SSHProfileEditor({ profile: initial, isNew }: { profile: SSHProfile; isNew: boolean }) {
  const dismiss = useDismiss()
  const [profile, setProfile] = useState(initial)
  const [port, setPort] = useState(initial.port?.toString() ?? '')
  const [remotePort, setRemotePort] = useState(String(initial.remotePort))
  const [user, setUser] = useState(initial.user ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const bridge = window.kith.ssh

  const save = async () => {
    const isInt = (s: string) => /^-?\d+$/.test(s)
    const portText = port.trim()
    if (portText && !isInt(portText)) return setProblem('The SSH port must be a number.')
    const remote = remotePort.trim()
    if (!isInt(remote)) return setProblem('The Kith port must be a number.')
    const u = user.trim()
    const p: SSHProfile = {
      ...profile,
      host: profile.host.trim(),
      name: profile.name.trim(),
      user: u || null,
      port: portText ? Number(portText) : null,
      remotePort: Number(remote),
    }
    const found = await bridge.save(p)
    if (found) return setProblem(found)
    dismiss()
  }

  const field = (label: string, value: string, set: (v: string) => void, prompt: string) => (
    <HStack gap={12} className="settings-row">
      <Text tone="text">{label}</Text>
      <input className="settings-field" aria-label={label} placeholder={prompt} value={value} spellCheck={false} onChange={(e) => set(e.target.value)} />
    </HStack>
  )

  return (
    // Return in a field saves (the default action).
    <VStack className="settings-ssh-editor" onKeyDown={(e) => e.key === 'Enter' && e.target instanceof HTMLInputElement && void save()}>
      <ModalHeader title={isNew ? 'Add SSH computer' : 'Edit SSH computer'} trailing={<IconButton title={isNew ? 'Add' : 'Save'} icon="checkmark" onClick={() => void save()} />} />
      <VStack gap={16} className="settings-ssh-editor-body">
        <CardSection>
          {field('Name', profile.name, (name) => setProfile({ ...profile, name }), 'Optional')}
          {field('Host', profile.host, (host) => setProfile({ ...profile, host }), 'SSH alias or hostname')}
          {field('User', user, setUser, 'From SSH config')}
          {field('SSH port', port, setPort, 'From SSH config')}
          <div className="settings-row">
            <span>Key</span>
            <Spacer />
            <Text tone="secondary">{profile.identityFile?.split('/').pop() ?? 'ssh-agent / SSH config'}</Text>
            <IconButton
              title="Choose key file"
              icon="key"
              onClick={() => void bridge.chooseKey().then((path) => path && setProfile((p) => ({ ...p, identityFile: path })))}
            />
            {profile.identityFile ? (
              <HStack as="span" align="stretch" className="settings-appear">
                <IconButton title="Use ssh-agent" icon="xmark.circle" onClick={() => setProfile({ ...profile, identityFile: null })} />
              </HStack>
            ) : null}
          </div>
          {field('Kith port', remotePort, setRemotePort, '')}
        </CardSection>
        <Text size="caption" tone="secondary">
          Kith opens an SSH tunnel to kith-serve on that computer's loopback. It uses your SSH config and ssh-agent; agent forwarding stays off.
        </Text>
        <Reveal show={problem !== null}>
          <Text size="caption" tone="danger">{problem}</Text>
        </Reveal>
      </VStack>
    </VStack>
  )
}
