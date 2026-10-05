import { useEffect, useState, type ReactNode } from 'react'
import { IconButton } from '../../components/Controls'
import { Dialog } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStore } from '../../store/context'
import { errorText, type RoutineWebhook } from './routine'

/** A labelled form field (kit's `Field`): the label, an optional detail, then the control. */
export function Field({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ color: 'var(--text)' }}>{label}</span>
        {detail ? <span style={{ ...font('caption'), color: 'var(--secondary)', lineHeight: 1.4 }}>{detail}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** A saved webhook routine's address and key: copy either, reveal or replace the key. */
export function RoutineWebhookPanel({ botId, routineId }: { botId: string; routineId: string }) {
  const store = useStore()
  const [webhook, setWebhook] = useState<RoutineWebhook | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState<'url' | 'key' | null>(null)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [rotating, setRotating] = useState(false)

  const load = async (rotate: boolean) => {
    setRotating(rotate)
    try {
      const value = await (await store.ready()).call<RoutineWebhook>('routineWebhook', { botId, id: routineId, rotate })
      setWebhook(value)
      if (rotate) {
        setCopied(null)
        setShowKey(true)
      }
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRotating(false)
    }
  }

  useEffect(() => {
    void load(false)
  }, [routineId])

  const value = (text: string, copy: 'url' | 'key', extra?: ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px 8px 12px', background: 'var(--bubble-user)', borderRadius: 12 }}>
      <span
        style={{
          ...font('callout', undefined, 'monospaced'),
          flex: 1,
          minWidth: 0,
          userSelect: 'text',
          wordBreak: 'break-all',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {text}
      </span>
      {extra}
      <IconButton
        title={copied === copy ? 'Copied' : 'Copy'}
        icon={copied === copy ? 'checkmark' : 'doc.on.doc'}
        onClick={() => {
          if (!webhook) return
          window.codync.app.copy(copy === 'key' ? webhook.key : (webhook.url ?? webhook.localUrl))
          setCopied(copy)
        }}
      />
    </div>
  )

  const caption = { ...font('caption'), paddingLeft: 4, lineHeight: 1.4 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {webhook ? (
        <>
          <Field label={webhook.url ? 'URL' : 'Local URL'}>{value(webhook.url ?? webhook.localUrl, 'url')}</Field>
          <Field label="Key">
            {value(
              showKey ? webhook.key : '•'.repeat(16),
              'key',
              <>
                <IconButton title={showKey ? 'Hide key' : 'Show key'} icon={showKey ? 'eye.slash' : 'eye'} onClick={() => setShowKey((s) => !s)} />
                <IconButton title="Replace key" icon="arrow.triangle.2.circlepath" disabled={rotating || store.isOffline} onClick={() => setConfirmRotate(true)} />
              </>,
            )}
          </Field>
          <span style={{ ...caption, color: 'var(--secondary)' }}>
            {webhook.url
              ? 'POST with Authorization: Bearer <key>. For GitHub, use content type application/json and the key as the secret. ' +
                'Deliveries wait up to 72 hours while this computer is off. They pass through the Codync cloud, which can read them.'
              : 'The Codync cloud is off, so only this computer can send to it.'}
          </span>
        </>
      ) : error ? (
        <span style={{ ...caption, color: 'var(--danger)' }}>{error}</span>
      ) : (
        <span style={{ ...caption, color: 'var(--secondary)' }}>Loading webhook…</span>
      )}
      <Dialog
        open={confirmRotate}
        title="Replace the key?"
        message="Senders using the current key stop working until they get the new one."
        actions={[{ title: 'Replace key', destructive: true, action: () => void load(true) }]}
        onClose={() => setConfirmRotate(false)}
      />
    </div>
  )
}
