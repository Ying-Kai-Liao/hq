import type { IncomingCall as Call } from '@shared/incoming-call'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { Text } from '../../components/Text'
import { useModel } from '../../lib/observable'
import { useApp } from '../../store/context'
import type { BotStore } from '../../store/bot-store'
import { ringTone } from './ring-tone'
import './call.css'

/**
 * An agent is calling: the oldest ringing call over the whole window, until someone answers on any device,
 * it is declined or its ring runs out. Accepting opens that chat and starts its voice call (`ThreadView` takes
 * `callToStart`). There is no push: this shows only while the app is open and connected.
 */
export function IncomingCalls() {
  const app = useApp()
  useModel(app)
  const stores = [...app.stores.values()]
  const [, tick] = useState(0)
  // One subscription per computer (a hook per store would change the hook count as computers come and go).
  const computers = stores.map((s) => s.computer.id).join()
  useEffect(() => {
    const stops = stores.map((s) => s.subscribe(() => tick((n) => n + 1)))
    return () => stops.forEach((stop) => stop())
  }, [computers])
  const ringing = stores.flatMap((s) => s.incomingCalls.map((call) => ({ store: s, call })))
  const next = ringing.reduce<number | null>((soonest, { call }) => (soonest === null ? call.deadline : Math.min(soonest, call.deadline)), null)

  // Calls drop out when their ring is over here too (the host's "missed" may not reach a device that lost the link).
  useEffect(() => {
    if (next === null) return
    const timer = setTimeout(() => {
      for (const s of stores) s.expireCalls()
    }, Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [next])

  const first = ringing[0]
  const id = first?.call.id ?? null
  useEffect(() => {
    if (!id) return
    window.kith.app.raiseWindow()
    return ringTone()
  }, [id])

  return first ? <Ringing key={first.call.id} store={first.store} call={first.call} onOpen={(botId) => app.select({ computerId: first.store.computer.id, botId })} /> : null
}

function Ringing({ store, call, onOpen }: { store: BotStore; call: Call; onOpen: (botId: string) => void }) {
  const bot = store.bots.get(call.botId)
  const name = bot?.name ?? call.name
  const [busy, setBusy] = useState(false)

  const accept = async () => {
    if (busy) return
    setBusy(true)
    if (await store.acceptCall(call)) onOpen(call.botId)
  }

  return (
    <div className="incoming-call" role="alertdialog" aria-label={`${name} is calling`}>
      <div className="call-screen-drag" />
      <div className="incoming-call-main">
        <span className="incoming-call-avatar">{bot ? <BotAvatar bot={bot} size={132} /> : null}</span>
        <Text size="title" weight="semibold" tone="text">{name}</Text>
        <Text as="div" size="body" tone="secondary" aria-live="polite">is calling</Text>
        {call.reason ? <Text as="div" size="body" tone="text" className="incoming-call-reason">{call.reason}</Text> : null}
      </div>
      <div className="incoming-call-controls">
        <button className="call-round big end" title="Decline" aria-label="Decline" onClick={() => store.declineCall(call)}>
          <Icon name="phone.down.fill" size={20} weight="semibold" scaled={false} />
        </button>
        <button className="call-round big accept" title="Accept" aria-label="Accept" disabled={busy} onClick={() => void accept()}>
          <Icon name="phone.fill" size={20} weight="semibold" scaled={false} />
        </button>
      </div>
    </div>
  )
}
