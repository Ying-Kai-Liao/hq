import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { CloudStatus, PairingInfo } from '@shared/models'
import { IconButton, Spinner } from '../components/Controls'
import { font } from '../lib/fonts'
import { LoopbackTransport } from '../client/host-client'
import { useApp } from '../store/context'

/** A one-time pairing QR (v3) from this computer: its keys, a code, and how to reach it. */
export function PairingWindow() {
  const app = useApp()
  const local = app.host.local
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [cloud, setCloud] = useState<CloudStatus | null>(null)
  const [name, setName] = useState('this computer')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!local) return setError("This computer's host isn't connected.")
    const transport = new LoopbackTransport(local.baseURL, local.token)
    try {
      const [pairing, status, hello] = await Promise.all([
        transport.call('pairing', {}, 20_000) as Promise<PairingInfo>,
        transport.call('cloudStatus', {}, 20_000).catch(() => null) as Promise<CloudStatus | null>,
        transport.call('hello', {}, 20_000).catch(() => null) as Promise<{ name?: string } | null>,
      ])
      setInfo(pairing)
      setCloud(status)
      if (hello?.name) setName(hello.name)
      setQr(await QRCode.toDataURL(pairing.pairingUrl, { errorCorrectionLevel: 'M', margin: 0, width: 400, color: { dark: '#000000', light: '#ffffff' } }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [local])

  // A new code each time "Pair iPhone…" is chosen (the window stays open between uses)…
  useEffect(() => {
    void load()
    return window.codync.app.onCommand((c) => c.kind === 'reviewApprovals' && void load())
  }, [load])

  // …and a fresh one when this code expires while it's on screen.
  useEffect(() => {
    if (!info?.expiresAt) return
    const timer = setTimeout(() => void load(), Math.max(1000, info.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [info?.expiresAt, load])

  return (
    <div style={{ width: 340, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      {info && qr ? (
        <>
          <div style={{ padding: 10, background: '#fff', borderRadius: 12 }}>
            <img src={qr} alt={`Pairing code for ${name}`} width={200} height={200} style={{ display: 'block', imageRendering: 'pixelated' }} />
          </div>
          <div style={{ ...font('caption'), color: 'var(--secondary)', textAlign: 'center' }}>
            Scan with the Codync app or the iPhone Camera. No Tailscale or open ports needed: your iPhone connects directly on the same Wi-Fi, and through the encrypted relay anywhere else.
          </div>
          {cloud?.enabled !== true ? (
            <div style={{ ...font('caption'), color: 'var(--warning)', textAlign: 'center' }}>
              {info.urls.length === 0
                ? 'No network address found and “Reach from anywhere” is off. Connect to Wi-Fi or turn it on.'
                : `“Reach from anywhere” is off, so the iPhone only reaches ${name} on the same network.`}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {info.expiresAt ? (
              <span style={{ ...font('caption2'), color: 'var(--tertiary)' }}>
                Works once, until {new Date(info.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </span>
            ) : null}
            <IconButton title="New code" icon="arrow.clockwise" onClick={() => void load()} />
            <IconButton title="Copy pairing link" icon="doc.on.doc" onClick={() => window.codync.app.copy(info.pairingUrl)} />
          </div>
        </>
      ) : error ? (
        <>
          <div style={{ ...font('caption'), color: 'var(--danger)', textAlign: 'center' }}>{error}</div>
          <IconButton title="Try again" icon="arrow.clockwise" onClick={() => void load()} />
        </>
      ) : (
        <Spinner size={20} />
      )}
    </div>
  )
}
