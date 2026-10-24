import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { CloudStatus, PairingInfo } from '@shared/models'
import { Button, IconButton, Spinner } from '../components/Controls'
import { Icon } from '../components/Icon'
import { HStack } from '../components/Stack'
import './pairing-window.css'

/** What a computer says about pairing: its one-time code, its name, and whether it's reachable from anywhere. */
export type PairingSource = { info: PairingInfo; name: string; cloud: CloudStatus | null }

/**
 * A one-time pairing QR (v3) from a computer: its keys, a code, and how to reach it. Shared by the Pair iPhone
 * window and the sheet in Settings. `load` throws when the computer can't be reached; its message is shown.
 * `cloud` (when given) is read live instead of from `load`. `reloadOnReview` also loads a new code each time
 * "Pair iPhone…" is chosen again (the window stays open between uses).
 */
export function PairingCode({ load, cloud: liveCloud, reloadOnReview = false }: { load: () => Promise<PairingSource>; cloud?: CloudStatus | null; reloadOnReview?: boolean }) {
  const [source, setSource] = useState<PairingSource | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the newest load may land, so pressing New code twice can't leave an older answer on screen.
  const latest = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++latest.current
    try {
      const next = await load()
      const url = await QRCode.toDataURL(next.info.pairingUrl, { errorCorrectionLevel: 'M', margin: 0, width: 400, color: { dark: '#000000', light: '#ffffff' } })
      if (mine !== latest.current) return
      setSource(next)
      setQr(url)
      setError(null)
    } catch (e) {
      if (mine === latest.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [load])

  useEffect(() => {
    void reload()
    if (!reloadOnReview) return
    return window.kith.app.onCommand((c) => c.kind === 'reviewApprovals' && void reload())
  }, [reload, reloadOnReview])

  // A fresh code when this one expires while it's on screen.
  const expiresAt = source?.info.expiresAt
  useEffect(() => {
    if (!expiresAt) return
    const timer = setTimeout(() => void reload(), Math.max(1000, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt, reload])

  if (source && qr) {
    const { info, name } = source
    const cloud = liveCloud !== undefined ? liveCloud : source.cloud
    const turnOn = (
      <>
        {' '}
        <button className="pairing-link" onClick={() => window.kith.app.openSettingsWindow('account')}>Turn on…</button>
      </>
    )
    return (
      <div className="pairing">
        <div className="pairing-qr">
          <img src={qr} alt={`Pairing code for ${name}`} width={184} height={184} />
        </div>
        <div className="pairing-heading">Scan with your iPhone</div>
        <div className="pairing-line">Open Kith on your iPhone and tap Add a Mac, or point the Camera at it.</div>
        <div className="pairing-route">
          <Icon name={cloud?.enabled === true ? 'lock.fill' : 'wifi'} size={13} />
          <span>
            {cloud?.enabled === true ? (
              'Same Wi-Fi connects directly; anywhere else goes through the encrypted relay.'
            ) : info.urls.length === 0 ? (
              <>No network address found and “Reach from anywhere” is off. Connect to Wi-Fi or turn it on.{turnOn}</>
            ) : (
              <>“Reach from anywhere” is off, so the iPhone only reaches {name} on the same network.{turnOn}</>
            )}
          </span>
        </div>
        <HStack gap={4} className="pairing-footer">
          {info.expiresAt ? <span>Works once, until {new Date(info.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span> : null}
          <IconButton title="New code" icon="arrow.clockwise" onClick={() => void reload()} />
          <IconButton title="Copy pairing link" icon="doc.on.doc" onClick={() => window.kith.app.copy(info.pairingUrl)} />
        </HStack>
      </div>
    )
  }
  if (error) {
    return (
      <div className="pairing pairing-error">
        <Icon name="desktopcomputer.trianglebadge.exclamationmark" size={40} color="var(--tertiary)" />
        <div className="pairing-heading">Kith’s host isn’t running</div>
        <div className="pairing-line">{error}</div>
        <Button kind="secondary" className="pairing-retry" onClick={() => void reload()}>Try again</Button>
      </div>
    )
  }
  return (
    <div className="pairing pairing-loading">
      <Spinner size={20} />
    </div>
  )
}
