import type { CallAnswer, IncomingPanelCall } from '@shared/incoming-call'
import { useEffect, useState } from 'react'
import { BotAvatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { pairOf } from '../../components/kith/pair'
import './call.css'

/**
 * The floating incoming-call panel's page (`?window=incoming-call`, opened by main/incoming-call.ts): sky, the bot in
 * its ring, who is calling and why, Decline and Accept. It holds no state of its own; the main process hands it the
 * call and carries the answer to the chat window.
 */
export function IncomingPanel() {
  const [call, setCall] = useState<IncomingPanelCall | null>(null)
  /** Set on the first press: a double click sends one answer. */
  const [answered, setAnswered] = useState<string | null>(null)
  useEffect(() => {
    void window.kith.incomingCall.current().then(setCall)
    return window.kith.incomingCall.onCall(setCall)
  }, [])
  if (!call) return null
  const pair = call.bot ? pairOf(call.bot.avatarColor) : null
  const press = (how: CallAnswer) => {
    if (answered === call.id) return
    setAnswered(call.id)
    window.kith.incomingCall.respond(call.id, how)
  }
  const busy = answered === call.id

  return (
    <div className="incoming-panel" role="alertdialog" aria-label={`${call.name} is calling`}>
      <div className="incoming-panel-sky" aria-hidden />
      <div className="incoming-panel-main">
        <div className="call-screen-via">Kith call</div>
        <span className="incoming-panel-avatar" style={pair ? ({ ['--ring-a' as string]: pair.a, ['--ring-b' as string]: pair.b } as React.CSSProperties) : undefined}>
          <span aria-hidden className="call-screen-ring incoming-panel-ring" />
          {call.bot ? <BotAvatar bot={call.bot} size={118} /> : null}
        </span>
        <div className="call-screen-name">{call.name}</div>
        <div className="incoming-panel-state" aria-live="polite">is calling you</div>
        {call.reason ? <div className="incoming-panel-reason">{call.reason}</div> : null}
      </div>
      <div className="incoming-panel-controls">
        <button className="call-ctl end" aria-label="Decline" disabled={busy} onClick={() => press('decline')}>
          <span className="call-round big"><Icon name="phone.down.fill" size={22} weight="semibold" scaled={false} /></span>
          <span className="call-ctl-label">Decline</span>
        </button>
        <button className="call-ctl" aria-label="Accept" disabled={busy} onClick={() => press('accept')}>
          <span className="call-round big accept"><Icon name="phone.fill" size={22} weight="semibold" scaled={false} /></span>
          <span className="call-ctl-label">Accept</span>
        </button>
      </div>
    </div>
  )
}
