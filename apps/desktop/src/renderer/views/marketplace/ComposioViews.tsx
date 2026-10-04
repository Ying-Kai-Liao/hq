import { useEffect, useRef, useState } from 'react'
import { Button, CardForm, CardSection, IconButton, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader, useDismiss } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import {
  appConnected, emptyPage, errorText, hasHiddenItems, market, replacePage, revealMore, sleep, visible,
  type ComposioApp, type ComposioConnect, type ComposioStatus,
} from './market-models'
import { AppLogo, ErrorText, Field, FormSheet, ItemGrid, MarketRow, MarketSection, SkeletonGrid, TileIcon, WebLink, filled, lineClamp } from './pieces'
import { pluginsFor } from './plugins'

// Apps through Composio (host/src/market/composio.rs): set up a key once, connect
// apps with Composio's hosted sign-in, then turn them on per bot like any
// other connector.

export { AppLogo }

/** The Marketplace's "Apps" section. */
export function ComposioSection({ query, searchToken }: {
  query: string
  /** Bumped by the Marketplace when the user submits a search. */
  searchToken: number
}) {
  const store = useStore()
  const [status, setStatus] = useState<ComposioStatus | null>(null)
  const [apps, setApps] = useState(emptyPage<ComposioApp>)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingUp, setSettingUp] = useState(false)
  const [connecting, setConnecting] = useState<ComposioApp | null>(null)
  const request = useRef(0)
  const queryRef = useRef(query)
  queryRef.current = query

  const load = async () => {
    const client = store.client
    if (!client) return
    const id = ++request.current
    const search = queryRef.current
    setLoading(true)
    try {
      const s = await market.composioStatus(client)
      const page = s.configured ? await market.composioApps(client, search) : []
      if (request.current !== id) return
      setStatus(s)
      setApps(replacePage(page, (a) => a.slug))
      setError(null)
    } catch (e) {
      if (request.current === id) setError(errorText(e))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    return () => void request.current++
  }, [searchToken])

  const configured = status?.configured === true
  return (
    <MarketSection title="Apps">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!configured ? (
          <ItemGrid>
            <MarketRow
              title="Composio"
              subtitle="Gmail, Slack, GitHub, Notion and 1,000 more apps"
              added={false}
              busy={status === null && loading}
              addLabel="Set up"
              icon={<TileIcon name="square.grid.3x3" />}
              onAdd={() => setSettingUp(true)}
            />
          </ItemGrid>
        ) : loading ? (
          <SkeletonGrid />
        ) : apps.items.length === 0 ? (
          <span style={{ color: 'var(--secondary)' }}>{query ? `No apps match “${query}”.` : "Couldn't load apps."}</span>
        ) : (
          <ItemGrid>
            {visible(apps).map((app) => (
              <MarketRow
                key={app.slug}
                title={app.name}
                subtitle={app.description ?? app.slug}
                added={appConnected(app)}
                addLabel="Connect"
                icon={<AppLogo url={app.logo} name={app.name} />}
                onAdd={() => setConnecting(app)}
              />
            ))}
          </ItemGrid>
        )}
        {!loading && hasHiddenItems(apps) && configured ? (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Button kind="secondary" onClick={() => setApps(revealMore)}>Load more apps</Button>
          </div>
        ) : null}
        {error ? <span style={{ ...font('footnote'), color: 'var(--danger)' }}>{error}</span> : null}
        {configured ? (
          <button style={{ display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start', ...font('footnote'), color: 'var(--tertiary)' }} onClick={() => setSettingUp(true)}>
            <Icon name="key" size={10} />
            Composio settings
          </button>
        ) : null}
      </div>
      <FormSheet open={settingUp} onClose={() => setSettingUp(false)}>
        <ComposioKeySheet
          status={status}
          done={(s) => {
            setStatus(s)
            void load()
          }}
        />
      </FormSheet>
      <FormSheet open={connecting !== null} onClose={() => setConnecting(null)}>
        {connecting ? (
          <ComposioConnectSheet
            key={connecting.slug}
            app={connecting}
            done={() => {
              void load()
              void pluginsFor(store).refresh()
            }}
          />
        ) : null}
      </FormSheet>
    </MarketSection>
  )
}

/** Paste (or remove) the Composio API key; the host checks it with Composio first. */
export function ComposioKeySheet({ status, done }: { status: ComposioStatus | null; done: (s: ComposioStatus) => void }) {
  const store = useStore()
  const dismiss = useDismiss()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (key: string) => {
    const client = store.client
    if (!client) return
    setSaving(true)
    try {
      done(await market.setComposioKey(client, key))
      dismiss()
    } catch (e) {
      setError(errorText(e))
    }
    setSaving(false)
  }

  const keyUrl = status?.keyUrl ?? 'https://platform.composio.dev'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' }}>
      <ModalHeader title="Composio" trailing={saving ? <Spinner /> : <IconButton title="Save" icon="checkmark" disabled={!key.trim()} onClick={() => void save(key)} />} />
      <CardForm>
        <CardSection
          title="Composio API key"
          footer={`Composio signs you in to apps like Gmail and Slack and runs their tools for your bots. The key stays on ${store.hostName}.`}
        >
          <Field label="API key" value={key} onChange={setKey} secret placeholder={status?.configured ? 'Saved (paste to replace)' : 'ak_…'} />
          {URL.canParse(keyUrl) ? <WebLink title="Get a key from Composio" url={keyUrl} style={font('footnote')} /> : null}
        </CardSection>
        {status?.configured ? (
          <CardSection footer="Bots lose the apps you connected until you add a key again.">
            <button style={{ color: 'var(--danger)' }} onClick={() => void save('')}>Remove key</button>
          </CardSection>
        ) : null}
        {error ? <CardSection><ErrorText text={error} /></CardSection> : null}
      </CardForm>
    </div>
  )
}

/**
 * Connects one app: Composio's sign-in page (opened here, finished anywhere),
 * or a form for apps that use a key.
 */
export function ComposioConnectSheet({ app, requestId, done }: { app: ComposioApp; requestId?: string; done: () => void }) {
  const store = useStore()
  const dismiss = useDismiss()
  const [plan, setPlan] = useState<ComposioConnect | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [connected, setConnected] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connectedRef = useRef(false)
  const doneRef = useRef(done)
  doneRef.current = done

  const markConnected = () => {
    setValues({})
    connectedRef.current = true
    setConnected(true)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const client = store.client
      if (!client) return
      try {
        const plan = await market.composioConnect(client, app.slug)
        if (cancelled) return
        setPlan(plan)
        if (plan.status !== 'redirect' || !plan.connection) return
        if (plan.url && URL.canParse(plan.url)) window.codync.app.openExternal(plan.url)
        // Polls until the sign-in finishes (or the sheet goes away).
        for (let i = 0; i < 300; i++) {
          await sleep(2000)
          if (cancelled) return
          const state = await market.composioConnection(client, plan.connection).catch(() => null)
          if (cancelled) return
          if (!state) continue
          if (state.status === 'active') {
            if (requestId) {
              try {
                await market.finishConnectionRequest(client, requestId, { connectorId: `composio-${app.slug}` })
              } catch (e) {
                if (!cancelled) setError(errorText(e))
                return
              }
            }
            if (!cancelled) markConnected()
            return
          }
          if (state.status === 'failed' || state.status === 'expired') {
            setError(`Signing in to ${app.name} didn't work (${state.status}). Close and try again.`)
            return
          }
        }
        setError('Timed out waiting for the sign-in.')
      } catch (e) {
        if (!cancelled) setError(errorText(e))
      }
    })()
    return () => {
      cancelled = true
      if (connectedRef.current) doneRef.current()
    }
  }, [store, app.slug, app.name, requestId])

  const submit = async () => {
    const client = store.client
    const mode = plan?.mode
    if (!client || !mode) return
    setSaving(true)
    try {
      const state = await market.composioConnectFields(client, app.slug, mode, filled(values))
      if (state.status === 'active') {
        if (requestId) await market.finishConnectionRequest(client, requestId, { connectorId: `composio-${app.slug}` })
        markConnected()
      } else {
        setError(`${app.name} says the connection is ${state.status}.`)
      }
    } catch (e) {
      setError(errorText(e))
    }
    setSaving(false)
  }

  const needsFields = plan?.status === 'needsFields'
  const trailing = connected
    ? <IconButton title="Done" icon="checkmark" onClick={dismiss} />
    : needsFields
      ? saving
        ? <Spinner />
        : <IconButton title="Connect" icon="checkmark" disabled={plan?.fields?.some((f) => f.required && !values[f.name]) ?? true} onClick={() => void submit()} />
      : null

  const waitingRow = (text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Spinner />
      <span style={{ color: 'var(--secondary)' }}>{text}</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' }}>
      <ModalHeader title={`Connect ${app.name}`} trailing={trailing} />
      <CardForm>
        <CardSection>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 0' }}>
            <AppLogo url={app.logo} name={app.name} size={52} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={font('title3', 'semibold')}>{app.name}</span>
              {app.description ? <span style={{ ...font('subheadline'), color: 'var(--secondary)', ...lineClamp(3) }}>{app.description}</span> : null}
            </div>
          </div>
        </CardSection>
        {connected ? (
          <CardSection footer={`Turn ${app.name} on for a bot in the bot's settings, under Connectors.`}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--added)' }}>
              <Icon name="checkmark.circle.fill" size={12} />
              Connected
            </span>
          </CardSection>
        ) : needsFields ? (
          <CardSection footer={`Sent to Composio, which keeps it for ${app.name}.`}>
            {(plan?.fields ?? []).map((f) => (
              <div key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Field label={f.label} value={values[f.name] ?? ''} secret={f.secret} placeholder={f.label} onChange={(v) => setValues((old) => ({ ...old, [f.name]: v }))} />
                {f.description ? <span style={{ ...font('caption'), color: 'var(--secondary)' }}>{f.description + (f.required ? '' : ' (optional)')}</span> : null}
              </div>
            ))}
          </CardSection>
        ) : plan?.status === 'redirect' ? (
          <CardSection footer="Sign in on the page that opened. This updates by itself when you're done.">
            {plan.url && URL.canParse(plan.url) ? (
              <div>
                <Button kind="secondary" onClick={() => window.codync.app.openExternal(plan.url!)}>
                  <Icon name="safari" size={11} />
                  Open the sign-in page
                </Button>
              </div>
            ) : null}
            {waitingRow('Waiting for you to finish signing in…')}
          </CardSection>
        ) : error === null ? (
          <CardSection>{waitingRow('Asking Composio…')}</CardSection>
        ) : null}
        {error ? <CardSection><ErrorText text={error} /></CardSection> : null}
      </CardForm>
    </div>
  )
}
