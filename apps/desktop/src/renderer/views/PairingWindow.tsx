import { useCallback } from 'react'
import type { CloudStatus, PairingInfo } from '@shared/models'
import { LoopbackTransport } from '../client/host-client'
import { useApp } from '../store/context'
import { PairingCode, type PairingSource } from './PairingCode'

/** The Pair iPhone window: a one-time pairing QR from this computer. */
export function PairingWindow() {
  const app = useApp()
  const local = app.host.local

  const load = useCallback(async (): Promise<PairingSource> => {
    if (!local) throw new Error("This computer's host isn't connected.")
    const transport = new LoopbackTransport(local.baseURL, local.token)
    const [info, cloud, hello] = await Promise.all([
      transport.call('pairing', {}, 20_000) as Promise<PairingInfo>,
      transport.call('cloudStatus', {}, 20_000).catch(() => null) as Promise<CloudStatus | null>,
      transport.call('hello', {}, 20_000).catch(() => null) as Promise<{ name?: string } | null>,
    ])
    return { info, cloud, name: hello?.name || 'this computer' }
  }, [local])

  return <PairingCode load={load} reloadOnReview />
}
