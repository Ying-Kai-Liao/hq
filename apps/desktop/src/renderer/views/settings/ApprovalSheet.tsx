import { useState } from 'react'
import { Button, Spinner } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { ModalHeader } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import type { Approval } from '../../store/app-model'
import { useApp } from '../../store/context'
import { errorText, Reveal, spacedCode } from './parts'

/**
 * A device asks for access through the account (spec §4.2 B). The code is the only thing that
 * tells a real request from a cloud swapping keys, so it's big and Approve is never the default.
 * Closing puts the request off (the sheet's onClose defers it).
 */
export function ApprovalSheet({ approval }: { approval: Approval }) {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = approval.request

  const decide = async (approve: boolean) => {
    setBusy(true)
    try {
      await app.decide(approval, approve)
      // The host's accessRequests event removes it; don't wait for that to close.
      app.deferApproval(approval)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const center = { textAlign: 'center' as const }
  return (
    <div style={{ width: 420, display: 'flex', flexDirection: 'column' }}>
      <ModalHeader title="Access request" />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '0 24px 24px' }}>
        <Icon name={request.platform === 'macos' ? 'laptopcomputer' : 'iphone'} size={40} weight="light" color="var(--secondary)" />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ ...font('title3', 'semibold'), ...center }}>
            {request.deviceName} wants to use {approval.store.hostName}
          </div>
          {request.email ? <div style={{ ...font('callout'), color: 'var(--secondary)' }}>Signed in as {request.email}</div> : null}
        </div>
        {request.code ? (
          <>
            <div className="selectable settings-appear" style={{ ...font(48, 'semibold', 'monospaced'), color: 'var(--text)' }} aria-label={`Code ${request.code.split('').join(' ')}`}>
              {spacedCode(request.code)}
            </div>
            <div style={{ ...font('callout'), color: 'var(--secondary)', ...center }}>
              Approve only if {request.deviceName} shows exactly this code. If it doesn't, deny: someone may be trying to get in.
            </div>
          </>
        ) : (
          <>
            <Spinner />
            <div style={{ ...font('callout'), color: 'var(--secondary)' }}>Waiting for {request.deviceName} to show its code…</div>
          </>
        )}
        <Reveal show={error !== null}>
          <div style={{ ...font('caption'), color: 'var(--danger)', ...center }}>{error}</div>
        </Reveal>
        <div style={{ display: 'flex', gap: 12 }}>
          <Button kind="secondary" onClick={() => void decide(false)} disabled={busy}>
            Deny
          </Button>
          <Button onClick={() => void decide(true)} disabled={busy || !request.code}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  )
}
