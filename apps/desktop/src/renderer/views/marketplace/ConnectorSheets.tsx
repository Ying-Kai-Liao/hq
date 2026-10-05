import { useEffect, useRef, useState } from 'react'
import { CardForm, CardSection, ChoiceList, IconButton, SegmentedChoice, Spinner } from '../../components/Controls'
import { ModalHeader, useDismiss } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { errorText, market, needsSignIn, type InstalledConnector, type MarketConnector, type MarketInput } from './market-models'
import { ErrorText, Field, WebLink } from './pieces'
import { usePlugins } from './plugins'

const sheetBody = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' } as const

export function InstallConnectorSheet({ item, requestId, done }: { item: MarketConnector; requestId?: string; done: () => void }) {
  const store = useStore()
  const plugins = usePlugins(store)
  const dismiss = useDismiss()
  const [optionId, setOptionId] = useState(item.options[0]?.id ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [installed, setInstalled] = useState<InstalledConnector | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const option = item.options.find((o) => o.id === optionId) ?? item.options[0]
  const value = (input: MarketInput) => values[input.name] ?? ''

  const install = async () => {
    if (!option) return
    setSaving(true)
    setError(null)
    try {
      const client = await store.ready()
      let c: InstalledConnector
      if (installed) c = (await market.connectors(client)).find((x) => x.id === installed.id) ?? installed
      else {
        c = await plugins.installConnector(item, option.id, values)
        setInstalled(c)
        setValues({})
      }
      if (needsSignIn(c)) await plugins.signIn(c.id)
      if (requestId) await market.finishConnectionRequest(client, requestId, { connectorId: c.id })
      else await market.verifyConnector(client, c.id)
      await plugins.refresh()
      done()
      dismiss()
    } catch (e) {
      setError(errorText(e))
    }
    setSaving(false)
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (item.options.length === 1 && item.options[0].inputs.length === 0) void install()
  }, [])

  const missing = !option || option.inputs.some((i) => i.required && !(values[i.name] ?? i.default ?? ''))
  return (
    <div style={sheetBody}>
      <ModalHeader
        title="Add connector"
        trailing={saving ? <Spinner /> : <IconButton title="Add" icon="plus" disabled={installed === null && missing} onClick={() => void install()} />}
      />
      <CardForm>
        <CardSection>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
            <span style={font('title3', 'semibold')}>{item.title}</span>
            {item.description ? <span style={{ color: 'var(--secondary)' }}>{item.description}</span> : null}
            {item.website && URL.canParse(item.website) ? (
              <WebLink title={item.website} url={item.website} style={{ ...font('footnote'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} />
            ) : null}
          </div>
        </CardSection>
        {item.options.length > 1 ? (
          <CardSection title="Runs">
            <ChoiceList
              selection={optionId}
              onChange={setOptionId}
              options={item.options.map((o) => ({ id: o.id, label: o.kind === 'remote' ? `Hosted by ${item.title}` : `On ${store.hostName} (${o.kind})` }))}
            />
          </CardSection>
        ) : null}
        {option ? (
          <CardSection title="Setup" footer={`Keys are saved on ${store.hostName} only.`}>
            {option.inputs.length === 0 ? (
              <span style={{ color: 'var(--secondary)' }}>
                {option.kind === 'remote' ? `No keys needed here. If ${item.title} wants you to sign in, its sign-in page opens next.` : 'No setup needed.'}
              </span>
            ) : null}
            {option.inputs.map((input) => (
              <div key={input.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Field
                  label={input.name}
                  value={value(input)}
                  secret={input.secret}
                  placeholder={input.secret ? input.name : (input.default ?? input.placeholder ?? input.name)}
                  onChange={(v) => setValues((old) => ({ ...old, [input.name]: v }))}
                />
                {input.description ? (
                  <span style={{ ...font('caption'), color: 'var(--secondary)' }}>{input.description + (input.required ? '' : ' (optional)')}</span>
                ) : null}
              </div>
            ))}
          </CardSection>
        ) : null}
        {error ? <CardSection><ErrorText text={error} /></CardSection> : null}
      </CardForm>
    </div>
  )
}

type Mode = 'command' | 'url' | 'config'

export function CustomConnectorSheet() {
  const store = useStore()
  const plugins = usePlugins(store)
  const dismiss = useDismiss()
  const [name, setName] = useState('')
  const [mode, setMode] = useState<Mode>('command')
  const [target, setTarget] = useState('')
  const [envText, setEnvText] = useState('')
  const [config, setConfig] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = mode === 'config' ? config.trim() !== '' : name.trim() !== '' && target.trim() !== ''

  const footer = {
    command: `Runs on ${store.hostName} in the bot's project folder. Quotes work like in a shell.`,
    url: 'A remote MCP server, streamable HTTP or SSE.',
    config: `Paste the MCP config from a README or another app (Claude, Cursor, VS Code). Every server in it is added. Saved on ${store.hostName} only.`,
  }[mode]

  const save = async () => {
    setSaving(true)
    setError(null)
    const remote = mode === 'url'
    const pairs: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const at = line.indexOf(remote ? ':' : '=')
      if (at < 0) continue
      const key = line.slice(0, at).trim()
      if (key) pairs[key] = line.slice(at + 1).trim()
    }
    try {
      const added = mode === 'config'
        ? await plugins.importConnectors(config)
        : [await plugins.addConnector({ name, command: remote ? null : target, url: remote ? target : null, env: remote ? {} : pairs, headers: remote ? pairs : {} })]
      for (const c of added) if (needsSignIn(c)) await plugins.signIn(c.id)
      dismiss()
    } catch (e) {
      setError(errorText(e))
    }
    setSaving(false)
  }

  return (
    <div style={sheetBody}>
      <ModalHeader title="Custom connector" trailing={saving ? <Spinner /> : <IconButton title="Add" icon="plus" disabled={!ready} onClick={() => void save()} />} />
      <CardForm>
        <CardSection footer={footer}>
          <SegmentedChoice selection={mode} onChange={setMode} options={[{ id: 'command', label: 'Command' }, { id: 'url', label: 'URL' }, { id: 'config', label: 'Config' }]} />
          {mode === 'config' ? <Field value={config} onChange={setConfig} placeholder={'{ "mcpServers": { … } }'} lines={[6, 16]} mono /> : null}
          {mode !== 'config' ? <Field value={name} onChange={setName} placeholder="Name" /> : null}
          {mode !== 'config' ? <Field value={target} onChange={setTarget} placeholder={mode === 'url' ? 'https://example.com/mcp' : 'npx -y @scope/server'} mono /> : null}
        </CardSection>
        {mode === 'url' ? (
          <CardSection title="Headers" footer={`Optional, one Name: value per line. Leave empty if the service has you sign in. Saved on ${store.hostName} only.`}>
            <Field value={envText} onChange={setEnvText} placeholder="Authorization: Bearer …" lines={[2, 6]} mono />
          </CardSection>
        ) : mode === 'command' ? (
          <CardSection title="Environment" footer={`One KEY=value per line. Saved on ${store.hostName} only.`}>
            <Field value={envText} onChange={setEnvText} placeholder="API_KEY=…" lines={[2, 6]} mono />
          </CardSection>
        ) : null}
        {error ? <CardSection><ErrorText text={error} /></CardSection> : null}
      </CardForm>
    </div>
  )
}

export function NewSkillSheet() {
  const store = useStore()
  const plugins = usePlugins(store)
  const dismiss = useDismiss()
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [instructions, setInstructions] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    try {
      await plugins.addSkill(name, summary, instructions)
      dismiss()
    } catch (e) {
      setError(errorText(e))
    }
    setSaving(false)
  }

  return (
    <div style={sheetBody}>
      <ModalHeader
        title="New skill"
        trailing={saving ? <Spinner /> : <IconButton title="Save" icon="checkmark" disabled={!name.trim() || !instructions.trim()} onClick={() => void save()} />}
      />
      <CardForm>
        <CardSection footer="The bot sees the name and when to use it, and reads the instructions only when a task fits.">
          <Field value={name} onChange={setName} placeholder="Name" />
          <Field value={summary} onChange={setSummary} placeholder="When to use it" lines={[2, 4]} />
        </CardSection>
        <CardSection title="Instructions">
          <Field value={instructions} onChange={setInstructions} placeholder="Step by step, in plain words…" lines={[6, 20]} />
        </CardSection>
        {error ? <CardSection><ErrorText text={error} /></CardSection> : null}
      </CardForm>
    </div>
  )
}
