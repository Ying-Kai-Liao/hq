import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { AccountApproval, AuthorizedDevice, PairingInfo } from '@shared/models'
import { newSSHProfile, type SSHProfile } from '@shared/ssh'
import { Button, CardSection, IconButton, Spinner, Switch } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog, ModalHeader, Sheet, useDismiss } from '../../components/Overlay'
import { HStack, IconSlot, Spacer, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { useAccount } from '../../store/account'
import type { BotStore } from '../../store/bot-store'
import { StoreContext, useApp } from '../../store/context'
import { ComputerBadge } from '../ComputerBadge'
import { deviceIcon, errorText, liveClient, relativeDay, Reveal, SectionHeader, statusText, thisMac } from './parts'
import { useSSH } from './ssh-model'
import { SSHRow } from './SSHRow'
import { VoiceChatSettingsView } from './VoiceChatSettingsView'
import '../pairing-window.css'

/**
 * Computers this app manages (itself and SSH), with their account, relay and authorized devices;
 * SSH profiles; and the account's other computers.
 */
export function ComputersView() {
  const app = useApp()
  const account = useAccount()
  const sshState = useSSH()
  const cloud = useModel(app.cloud)
  const [editing, setEditing] = useState<{ profile: SSHProfile; isNew: boolean } | null>(null)
  const managed = app.managedStores
  const managedIds = new Set(managed.map((s) => s.computer.id))
  const reached = app.computers.filter((c) => !managedIds.has(c.id))
  const others = cloud.computers.filter((c) => !managedIds.has(c.computerId) && !reached.some((r) => r.id === c.computerId))

  return (
    <div className="settings-computers">
      <VStack gap={26} className="settings-computers-content">
        {managed.map((store) => (
          <ManagedComputerCard key={store.computer.id} store={store} ssh={sshState.isSSH(store.computer.id)} />
        ))}

        <div>
          <SectionHeader title="Over SSH">
            <IconButton title="Add SSH computer" icon="plus" onClick={() => setEditing({ profile: newSSHProfile(window.codync.hostPort), isNew: true })} />
          </SectionHeader>
          <Reveal show={sshState.state.profiles.length === 0}>
            <Text as="div" size="callout" tone="secondary">
              Run bots on another computer you reach with SSH. It needs codync-host installed; your SSH keys stay on {thisMac}.
            </Text>
          </Reveal>
          {sshState.state.profiles.map((profile) => (
            <SSHRow key={profile.id} profile={profile} status={sshState.status(profile.id)} edit={() => setEditing({ profile, isNew: false })} />
          ))}
        </div>

        <div>
          <SectionHeader title="In your account">
            {account.isSignedIn ? <IconButton title="Refresh" icon="arrow.clockwise" onClick={() => void cloud.refresh()} /> : null}
          </SectionHeader>
          {!account.isSignedIn ? (
            <Text as="div" size="callout" tone="secondary">Sign in to reach the other computers in your account from {thisMac}.</Text>
          ) : reached.length === 0 && others.length === 0 ? (
            <Text as="div" size="callout" tone="secondary">No other computers in your account yet.</Text>
          ) : null}
          {reached.map((computer) => {
            const store = app.store(computer.id)
            if (!store) return null
            const cloudEntry = cloud.computers.find((c) => c.computerId === computer.id)
            const stale = !!cloudEntry && cloud.isOlderCopy(cloudEntry) && store.connection.kind !== 'unauthorized'
            return (
              <div key={computer.id} className="settings-card settings-appear">
                <div className="settings-row">
                  <ComputerBadge computer={store.computer} size={22} />
                  <div className="settings-stack">
                    <Text size="callout" weight="medium">{store.hostName}</Text>
                    <Text size="caption" tone={stale ? 'attention' : 'secondary'}>
                      {stale ? `Older copy of this computer · ${statusText(store)}` : statusText(store)}
                    </Text>
                  </div>
                  <RouteIcon store={store} />
                  <Spacer />
                  <IconButton title={`Remove from ${thisMac}`} icon="minus.circle" onClick={() => app.detach(computer.id)} />
                </div>
              </div>
            )
          })}
          {others.map((computer) => (
            // An account computer this app isn't authorized on. Asking for access lives in the cloud model.
            <div key={computer.computerId} className="settings-card settings-appear">
              <div className="settings-row">
                <ComputerBadge computer={{ id: computer.computerId, name: computer.name, signKey: computer.signKey, urls: [], device: computer.device ?? null }} size={22} />
                <div className="settings-stack">
                  <Text size="callout" weight="medium">{computer.name}</Text>
                  <Text size="caption" tone="secondary">{computer.online ? 'Online' : 'Offline'}</Text>
                </div>
              </div>
            </div>
          ))}
        </div>
      </VStack>

      <Sheet open={editing !== null} onClose={() => setEditing(null)} width={460}>
        {editing ? <SSHProfileEditor key={editing.profile.id} profile={editing.profile} isNew={editing.isNew} /> : null}
      </Sheet>
    </div>
  )
}

/** How this app reaches a computer: direct LAN or the encrypted relay. */
function RouteIcon({ store }: { store: BotStore }) {
  if (store.connection.kind !== 'online' || !store.hostRoute || store.hostRoute === 'loopback') return null
  const relay = store.hostRoute === 'relay'
  return (
    <HStack as="span" align="stretch" title={relay ? 'Through Cloudflare (encrypted)' : 'Direct: Wi-Fi or Tailscale'} aria-label={relay ? 'Through Cloudflare' : 'Wi-Fi or Tailscale'} className="settings-route">
      <Icon name={relay ? 'cloud' : 'wifi'} size={12} />
    </HStack>
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
  const [showVoice, setShowVoice] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<AuthorizedDevice | null>(null)
  const [confirmUnclaim, setConfirmUnclaim] = useState(false)
  const [confirmAutoApproval, setConfirmAutoApproval] = useState(false)
  const cloud = store.cloud
  const autoApproval = cloud?.approval === 'auto'
  const online = store.connection.kind === 'online'
  const name = store.hostName

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
    : (cloud.lastError ?? (cloud.connected ? 'Reachable from anywhere through Cloudflare (encrypted).' : 'Connecting to Cloudflare…'))

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

  return (
    <VStack gap={28}>
      <CardSection>
        {[
          <div key="header" className="settings-row">
            <ComputerBadge computer={store.computer} size={26} />
            <VStack grow className="settings-stack">
              <Text size="headline">{name}</Text>
              <Text size="caption" tone="secondary">
                {overSSH ? 'Over SSH' : isMacLabel} · {statusText(store)}
              </Text>
            </VStack>
            {overSSH ? (
              // This computer's voice settings are their own Settings page.
              <IconButton title="Voice chat" icon="waveform" selected={showVoice} disabled={!online} onClick={() => setShowVoice((s) => !s)} />
            ) : null}
            <IconButton title="Pair iPhone" icon="qrcode" selected={showPairing} disabled={!online} onClick={() => setShowPairing((s) => !s)} />
          </div>,
          <Switch key="cloud" on={cloud?.enabled ?? false} disabled={busy || !online} onChange={(on) => run(() => app.cloud.setCloud(store, on))}>
            <span className="settings-stack">
              <span>Reach from anywhere</span>
              <Text size="caption" tone={cloud?.lastError ? 'attention' : 'secondary'}>{cloudLine}</Text>
            </span>
          </Switch>,
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

      <CardSection title={`Devices that can use ${name}`}>
        {devices === null
          ? [<Spinner key="loading" />]
          : [
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
                  <IconButton title="Revoke access" icon="xmark.circle" onClick={() => setConfirmRevoke(device)} />
                </HStack>
              )),
            ]}
      </CardSection>

      <Sheet open={showVoice} onClose={() => setShowVoice(false)}>
        <StoreContext.Provider value={store}>
          <VoiceChatSettingsView />
        </StoreContext.Provider>
      </Sheet>
      <Sheet open={showPairing} onClose={() => setShowPairing(false)} width={340}>
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
        message={`Any device signed in to your account gets full control of ${name}: its files, terminals and bots, with no check here. If someone gets into your account, or Codync's cloud is ever compromised, they could add their own device and you'd have no chance to stop it. Devices paired with a QR code aren't affected.`}
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
    </VStack>
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
            Scan with the Codync app or the iPhone Camera. No Tailscale or open ports needed: your iPhone connects directly on the same Wi-Fi, and through the encrypted relay anywhere else.
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
            <IconButton title="Copy pairing link" icon="doc.on.doc" onClick={() => window.codync.app.copy(info.pairingUrl)} />
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
  const bridge = window.codync.ssh

  const save = async () => {
    const isInt = (s: string) => /^-?\d+$/.test(s)
    const portText = port.trim()
    if (portText && !isInt(portText)) return setProblem('The SSH port must be a number.')
    const remote = remotePort.trim()
    if (!isInt(remote)) return setProblem('The Codync port must be a number.')
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
          {field('Codync port', remotePort, setRemotePort, '')}
        </CardSection>
        <Text size="caption" tone="secondary">
          Codync opens an SSH tunnel to codync-host on that computer's loopback. It uses your SSH config and ssh-agent; agent forwarding stays off.
        </Text>
        <Reveal show={problem !== null}>
          <Text size="caption" tone="danger">{problem}</Text>
        </Reveal>
      </VStack>
    </VStack>
  )
}
