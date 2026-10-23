import { useState } from 'react'
import { isUnsupportedHost } from '@shared/kith-info'
import { Button } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { HStack, VStack } from '../../components/Stack'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { useApp } from '../../store/context'
import type { LinkCode } from '../../store/bot-store'
import { errorText } from './parts'

/** "Link Telegram or Discord": a one-time code that ties a chat account to your Kith person. */
export function LinkChatRow() {
  const app = useApp()
  const local = useModel(app.local)
  const [code, setCode] = useState<LinkCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!local || local.connection.kind !== 'online' || unsupported) return null

  const request = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      setCode(await local.linkCode())
    } catch (e) {
      // An older host doesn't know the method: the row goes away rather than failing.
      if (isUnsupportedHost(e)) setUnsupported(true)
      else setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = () => {
    if (!code) return
    void navigator.clipboard.writeText(`/link ${code.code}`).then(() => setCopied(true), () => setError("Couldn't copy the code."))
  }
  const minutes = code ? Math.max(1, Math.round((code.expiresAt - Date.now()) / 60_000)) : 0

  return (
    <VStack gap={8}>
      <div className="settings-row">
        <Icon name="link" size={26} color="var(--secondary)" />
        <VStack grow className="settings-stack">
          <Text truncate>Link Telegram or Discord</Text>
          <Text size="caption" tone="secondary">Chat with your bots from your own Telegram or Discord account</Text>
        </VStack>
        <Button kind="secondary" onClick={() => void request()} disabled={busy}>
          {code ? 'New code' : 'Link'}
        </Button>
      </div>
      {code ? (
        <VStack gap={6} className="settings-link-code">
          <HStack gap={10} align="center">
            <Text as="div" size={28} weight="semibold" className="settings-link-code-value">{code.code}</Text>
            <Button kind="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          </HStack>
          <Text size="footnote" tone="secondary">
            Send /link {code.code} to your Kith bot in Telegram or Discord. Expires in about {minutes} min.
          </Text>
        </VStack>
      ) : null}
      {error ? <Text size="footnote" tone="attention">{error}</Text> : null}
    </VStack>
  )
}
