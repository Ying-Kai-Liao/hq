import { useState } from 'react'
import type { Entry } from '@shared/models'
import { Button, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { ComposioConnectSheet } from './ComposioViews'
import { InstallConnectorSheet } from './ConnectorSheets'
import {
  errorText, market, needsSignIn,
  type ComposioApp, type ConnectionRequest, type MarketConnector,
} from './market-models'
import { Field, FormSheet } from './pieces'
import { pluginsFor } from './plugins'

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
