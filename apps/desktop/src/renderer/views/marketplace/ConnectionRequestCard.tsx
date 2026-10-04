import { useEffect, useState } from 'react'
import type { Entry } from '@shared/models'
import { Button, CardForm, CardSection, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader, useDismiss } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { ComposioConnectSheet } from './ComposioViews'
import { InstallConnectorSheet } from './ConnectorSheets'
import {
  errorText, market, needsSignIn,
  type ComposioApp, type ConnectionRequest, type CredentialStatus, type InstalledConnector, type MarketConnector, type SavedLogin,
} from './market-models'
import { ErrorText, Field, FormSheet, filled } from './pieces'
import { pluginsFor, usePlugins } from './plugins'

const caption = { ...font('caption'), color: 'var(--secondary)' }

/** Credentials go through the setup API; only the request's state is a chat entry. */
export function ConnectionRequestCard({ entry }: { entry: Entry }) {
  const store = useStore()
  const request = entry.data.connectionRequest as unknown as ConnectionRequest
  const [app, setApp] = useState<ComposioApp | null>(null)
  const [item, setItem] = useState<MarketConnector | null>(null)
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isLogin = request.kind === 'login'
  const isSecret = request.kind === 'secret'

  const connect = async () => {
    const client = store.client
    if (!client) return
    setBusy(true)
    setError(null)
    try {
      if (request.kind === 'app' && request.toolkit) {
        setApp({ slug: request.toolkit, name: request.title })
      } else if (isLogin) {
        await market.finishConnectionRequest(client, entry.id, { value, username })
        setValue('')
      } else if (isSecret) {
        await market.finishConnectionRequest(client, entry.id, { value })
        setValue('')
      } else if (request.connectorId) {
        const id = request.connectorId
        const connector = (await market.connectors(client)).find((c) => c.id === id)
        if (connector && needsSignIn(connector)) await pluginsFor(store).signIn(id)
        await market.finishConnectionRequest(client, entry.id, { connectorId: id })
      } else if (request.registryName) {
        setItem(await market.connectorInfo(client, request.registryName))
      }
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const cancel = async () => {
    const client = store.client
    if (!client) return
    setBusy(true)
    try {
      await market.finishConnectionRequest(client, entry.id, { cancel: true })
      setValue('')
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: 'var(--surface)', borderRadius: 18 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...font('headline') }}>
        <Icon name="lock.shield" size={13} />
        {request.title}
      </span>
      {entry.data.text ? <span style={{ color: 'var(--secondary)' }}>{entry.data.text}</span> : null}
      {request.status === 'pending' ? (
        <>
          {isLogin ? (
            <>
              <Field value={username} onChange={setUsername} placeholder="Username or email" />
              <Field value={value} onChange={setValue} placeholder="Password or op:// reference" secret />
              <span style={caption}>Saved securely on this computer. The bot types it into the sign-in page but never sees it.</span>
            </>
          ) : isSecret ? (
            <>
              <span style={caption}>{`${request.field ?? 'Credential'} · ${request.location ?? ''}`}</span>
              <Field value={value} onChange={setValue} placeholder="Credential or op:// reference" secret />
              <span style={caption}>Saved securely on this computer. Never added to the conversation.</span>
            </>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button disabled={busy || ((isSecret || isLogin) && !value)} onClick={() => void connect()}>
              {isLogin ? 'Save login' : isSecret ? 'Save and connect' : 'Connect'}
            </Button>
            <Button kind="secondary" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
            {busy ? <Spinner /> : null}
          </div>
        </>
      ) : (
        <span style={{ color: 'var(--secondary)' }}>{request.status === 'ready' ? (isLogin ? 'Saved' : 'Connected') : 'Cancelled'}</span>
      )}
      {error ? <span style={{ ...font('footnote'), color: 'var(--danger)' }}>{error}</span> : null}
      <FormSheet open={item !== null} onClose={() => setItem(null)}>
        {item ? <InstallConnectorSheet item={item} requestId={entry.id} done={() => setItem(null)} /> : null}
      </FormSheet>
      <FormSheet open={app !== null} onClose={() => setApp(null)}>
        {app ? <ComposioConnectSheet app={app} requestId={entry.id} done={() => setApp(null)} /> : null}
      </FormSheet>
    </div>
  )
}

export function CredentialsView() {
  const store = useStore()
  const plugins = usePlugins(store)
  const [selected, setSelected] = useState<InstalledConnector | null>(null)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<CredentialStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      await plugins.refresh()
      const client = store.client
      if (!client) return
      try {
        setStatus(await market.credentialStatus(client))
      } catch (e) {
        setError(errorText(e))
      }
    })()
  }, [plugins, store])

  const save = async (value: string) => {
    const client = store.client
    if (!client) return
    setBusy(true)
    setError(null)
    try {
      setStatus(await market.setOnePasswordToken(client, value))
      setToken('')
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' }}>
      <ModalHeader title="Credentials" />
      <CardForm>
        <CardSection title="Storage">
          <span>{status?.provider ?? 'System credential store'}</span>
          <span style={{ color: 'var(--secondary)' }}>Credentials are encrypted on the connected computer. Linux uses Secret Service; macOS uses Keychain.</span>
        </CardSection>
        <CardSection title="Saved connections">
          {plugins.installedConnectors.filter((c) => c.keys.length > 0).map((c) => (
            <button key={c.id} className="plain-row-button" onClick={() => setSelected(c)}>
              <span style={{ flex: 1 }}>{c.name}</span>
              <Icon name="chevron.right" size={10} />
            </button>
          ))}
          <span style={caption}>Values stay hidden. Select a connection to replace its credentials.</span>
        </CardSection>
        <LoginsSection />
        <CardSection title="1Password" footer="Use a service account with read access only to a dedicated shared vault. The 1Password CLI must be installed on the computer.">
          <span>{status?.onePasswordConnected ? 'Connected' : 'Connect a shared vault'}</span>
          <Field value={token} onChange={setToken} placeholder="Service account token" secret />
          <div><Button disabled={busy || !token} onClick={() => void save(token)}>Connect</Button></div>
          {status?.onePasswordConnected ? <div><Button kind="secondary" disabled={busy} onClick={() => void save('')}>Disconnect</Button></div> : null}
          <span style={{ ...font('footnote'), color: 'var(--secondary)' }}>Use op://vault/item/field in a connector's credential field. Codync retrieves the value when the connector runs.</span>
        </CardSection>
        {busy ? <Spinner /> : null}
        {error ? <ErrorText text={error} /> : null}
      </CardForm>
      <FormSheet open={selected !== null} onClose={() => setSelected(null)}>
        {selected ? <ConnectorCredentialEditor key={selected.id} connector={selected} /> : null}
      </FormSheet>
    </div>
  )
}

/** Website and app logins bots type through the computer tool; passwords stay hidden. */
function LoginsSection() {
  const store = useStore()
  const [logins, setLogins] = useState<SavedLogin[]>([])
  const [site, setSite] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const client = store.client
    try {
      setLogins(client ? await market.logins(client) : [])
    } catch (e) {
      setError(errorText(e))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    const client = store.client
    if (!client) return
    setBusy(true)
    setError(null)
    try {
      await market.saveLogin(client, site, username, password)
      setSite('')
      setUsername('')
      setPassword('')
      await load()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const remove = async (login: SavedLogin) => {
    const client = store.client
    if (!client) return
    try {
      await market.removeLogin(client, login.id)
      setLogins((old) => old.filter((l) => l.id !== login.id))
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <CardSection title="Sign-ins" footer="Bots type these into the matching website or app and never see the password. You can use an op:// reference.">
      {logins.map((login) => (
        <div key={login.id} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            <span>{login.site}</span>
            {login.username ? <span style={caption}>{login.username}</span> : null}
          </div>
          <IconButton title="Remove" icon="trash" onClick={() => void remove(login)} />
        </div>
      ))}
      <Field value={site} onChange={setSite} placeholder="Website or app, e.g. github.com" />
      <Field value={username} onChange={setUsername} placeholder="Username or email" />
      <Field value={password} onChange={setPassword} placeholder="Password or op:// reference" secret />
      <div><Button disabled={busy || !site || !password} onClick={() => void save()}>Save sign-in</Button></div>
      {error ? <span style={{ ...font('footnote'), color: 'var(--danger)' }}>{error}</span> : null}
    </CardSection>
  )
}

function ConnectorCredentialEditor({ connector }: { connector: InstalledConnector }) {
  const store = useStore()
  const dismiss = useDismiss()
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const client = store.client
    if (!client) return
    setSaving(true)
    setError(null)
    try {
      await market.updateConnectorCredentials(client, connector.id, filled(fields))
      setFields({})
      dismiss()
    } catch (e) {
      setError(errorText(e))
    }
    setSaving(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' }}>
      <ModalHeader
        title={connector.name}
        trailing={saving ? <Spinner /> : <IconButton title="Save credentials" icon="checkmark" disabled={Object.values(fields).every((v) => !v)} onClick={() => void save()} />}
      />
      <CardForm>
        <CardSection footer="Enter only the values you want to replace. You can use an op:// reference.">
          {connector.keys.map((key) => (
            <Field key={key} label={key} value={fields[key] ?? ''} placeholder={key} secret onChange={(v) => setFields((old) => ({ ...old, [key]: v }))} />
          ))}
        </CardSection>
        {error ? <ErrorText text={error} /> : null}
      </CardForm>
    </div>
  )
}
