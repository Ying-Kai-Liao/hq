import { useEffect, useState, type ReactNode } from 'react'
import { IconButton } from '../../components/Controls'
import { Dialog } from '../../components/Overlay'
import { HStack, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useStore } from '../../store/context'
import { Field } from '../bots/parts'
import { errorText, type RoutineWebhook } from './routine'
import './routines.css'

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
    <HStack gap={8} className="routine-webhook-value">
      <Text size="callout" mono lines={2} grow className="routine-webhook-text">
        {text}
      </Text>
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
    </HStack>
  )

  return (
    <VStack gap={14}>
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
          <Text size="caption" tone="secondary" className="routine-caption">
            {webhook.url
              ? 'POST with Authorization: Bearer <key>. For GitHub, use content type application/json and the key as the secret. ' +
                'Deliveries wait up to 72 hours while this computer is off. They pass through the Codync cloud, which can read them.'
              : 'The Codync cloud is off, so only this computer can send to it.'}
          </Text>
        </>
      ) : error ? (
        <Text size="caption" tone="danger" className="routine-caption">{error}</Text>
      ) : (
        <Text size="caption" tone="secondary" className="routine-caption">Loading webhook…</Text>
      )}
      <Dialog
        open={confirmRotate}
        title="Replace the key?"
        message="Senders using the current key stop working until they get the new one."
        actions={[{ title: 'Replace key', destructive: true, action: () => void load(true) }]}
        onClose={() => setConfirmRotate(false)}
      />
    </VStack>
  )
}
