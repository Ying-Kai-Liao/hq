import type { IncomingCall as Call } from '@shared/incoming-call'
import { useEffect, useRef, useState } from 'react'
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

  // One call at a time, the newest: the floating panel (or this window) never stacks them.
  const first = ringing[ringing.length - 1]
  const id = first?.call.id ?? null
  /** The call the floating panel (or a notification) shows; while it does, this window shows nothing. */
  const [paneled, setPaneled] = useState<string | null>(null)
  const answered = useRef(new Set<string>())

  const answer = async (store: BotStore, call: Call, how: 'accept' | 'decline') => {
    if (answered.current.has(call.id)) return
    answered.current.add(call.id)
    if (how === 'decline') return store.declineCall(call)
    if (await store.acceptCall(call)) app.select({ computerId: store.computer.id, botId: call.botId })
  }
  const latest = useRef({ ringing, answer })
  latest.current = { ringing, answer }
  useEffect(() => window.kith.incomingCall.onAnswer(({ id: callId, answer: how }) => {
    const hit = latest.current.ringing.find(({ call }) => call.id === callId)
    if (hit) void latest.current.answer(hit.store, hit.call, how)
  }), [])

  useEffect(() => {
    if (!first) return
    const { call } = first
    let live = true
    const bot = first.store.bots.get(call.botId) ?? null
    void window.kith.incomingCall
      .show({ id: call.id, name: bot?.name ?? call.name, reason: call.reason, bot, deadline: call.deadline })
      .catch(() => false)
      .then((shown) => {
        if (!live) return
        if (shown) setPaneled(call.id)
        else window.kith.app.raiseWindow()
      })
    const stopRing = ringTone()
    return () => {
      live = false
      stopRing()
      setPaneled(null)
      // Over here (answered, declined, timed out or answered on another device): the panel goes too.
      window.kith.incomingCall.close(call.id)
    }
  }, [id])

  return first && paneled !== id ? <Ringing key={first.call.id} store={first.store} call={first.call} onAnswer={(how) => void answer(first.store, first.call, how)} /> : null
}

function Ringing({ store, call, onAnswer }: { store: BotStore; call: Call; onAnswer: (how: 'accept' | 'decline') => void }) {
  const bot = store.bots.get(call.botId)
  const name = bot?.name ?? call.name
  const [busy, setBusy] = useState(false)
  const press = (how: 'accept' | 'decline') => {
    if (busy) return
    setBusy(true)
    onAnswer(how)
  }

  return (
    <div className="incoming-call" role="alertdialog" aria-label={`${name} is calling`}>
      <div className="call-screen-sky" aria-hidden />
      <div className="call-screen-drag" />
      <div className="incoming-call-main">
        <span className="incoming-call-avatar">{bot ? <BotAvatar bot={bot} size={132} /> : null}</span>
        <div className="call-screen-name">{name}</div>
        <Text as="div" size="body" tone="secondary" aria-live="polite">is calling</Text>
        {call.reason ? <Text as="div" size="body" tone="text" className="incoming-call-reason">{call.reason}</Text> : null}
      </div>
      <div className="incoming-call-controls">
        <button className="call-ctl end" title="Decline" aria-label="Decline" disabled={busy} onClick={() => press('decline')}>
          <span className="call-round big"><Icon name="phone.down.fill" size={22} weight="semibold" scaled={false} /></span>
          <span className="call-ctl-label">Decline</span>
        </button>
        <button className="call-ctl accept" title="Accept" aria-label="Accept" disabled={busy} onClick={() => press('accept')}>
          <span className="call-round big accept"><Icon name="phone.fill" size={22} weight="semibold" scaled={false} /></span>
          <span className="call-ctl-label">Accept</span>
        </button>
      </div>
    </div>
  )
}
