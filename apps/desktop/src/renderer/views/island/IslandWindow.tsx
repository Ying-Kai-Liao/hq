import { useEffect, useRef } from 'react'
import { contentTop, type IslandBot, type IslandPermission } from '@shared/island'
import { CharacterAvatar } from '../../components/Avatar'
import { Button, IconButton, Spinner } from '../../components/Controls'
import { ThinkingOrb } from '../../components/ThinkingOrb'
import { useModel } from '../../lib/observable'
import type { IslandModel } from './island-model'
import './island.css'

const INK = '#f2f2f2'

/** The notch island: a black shape at the top of the screen that grows from the notch. */
export function IslandWindow({ model }: { model: IslandModel }) {
  useModel(model)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = content.current
    if (!el) return
    const observer = new ResizeObserver(() => model.setContentHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [model])

  const { mode, frame } = model
  const closed = mode === 'compact' || mode === 'hidden'
  return (
    <div
      className={`island ${model.growing ? 'growing' : 'shrinking'}`}
      data-mode={mode}
      style={{ width: frame.width, height: frame.height }}
      role={closed ? 'button' : undefined}
      aria-label={closed ? 'Show bots' : undefined}
      onClick={closed ? () => model.openNow() : undefined}
    >
      <span className="island-ear left" />
      <span className="island-ear right" />
      <div className="island-body" style={{ borderBottomLeftRadius: frame.radius, borderBottomRightRadius: frame.radius }}>
        {mode === 'compact' ? <Compact model={model} height={frame.height} /> : null}
        <div className="island-content" ref={content} style={{ top: contentTop(model.screen), width: frame.width }}>
          {mode === 'bots' ? <BotList model={model} /> : null}
          {mode === 'approval' && model.permission ? <Approval model={model} card={model.permission} /> : null}
          {mode === 'finished' && model.finished ? <Finished model={model} bot={model.finished} /> : null}
        </div>
      </div>
    </div>
  )
}

/** The notch widened: the bot in focus on the left, how many work or that one waits on the right. */
function Compact({ model, height }: { model: IslandModel; height: number }) {
  const focus = model.focus
  const count = model.activeCount
  return (
    <div className="island-compact" style={{ height }}>
      <span className="island-wing">{focus ? <Avatar bot={focus} size={Math.min(20, height - 10)} /> : null}</span>
      <span className="island-wing">
        {focus?.status === 'needsInput' ? <span className="island-dot" /> : count > 1 ? <span className="island-count">{count}</span> : <ThinkingOrb size={14} color={INK} />}
      </span>
    </div>
  )
}

function BotList({ model }: { model: IslandModel }) {
  const bots = model.bots
  if (bots.length === 0) return <div className="island-empty">No bots yet</div>
  return (
    <div className="island-list">
      {bots.map((bot) => (
        <button key={bot.ref} className="island-row" onClick={() => model.openBot(bot.ref)} title="Open conversation">
          <Avatar bot={bot} size={24} />
          <span className="island-text">
            <span className="island-name">{bot.name}</span>
            <span className="island-detail">{bot.detail}</span>
          </span>
          <Status bot={bot} />
        </button>
      ))}
    </div>
  )
}

function Approval({ model, card }: { model: IslandModel; card: IslandPermission }) {
  const count = model.summary.permissions.length
  return (
    <div className="island-approval">
      <div className="island-head">
        <CharacterAvatar shape={card.bot.shape} color={card.bot.color} size={22} mood="needsInput" dark />
        <span className="island-name">{card.bot.name}</span>
        <span className="island-detail">{card.headline}</span>
        <span style={{ flex: 1 }} />
        {count > 1 ? <span className="island-detail">{`${count} waiting`}</span> : null}
        <IconButton icon="arrow.up.right.square" title="Open conversation" size={24} onClick={() => model.openBot(card.ref)} />
        <IconButton icon="chevron.up" title="Later" size={24} onClick={() => model.later(card)} />
      </div>
      {card.title ? <div className="island-command">{card.title}</div> : null}
      <div className="island-options">
        {card.options.map((o, i) => (
          <Button
            key={o.id}
            kind={i === 0 && o.allow ? 'primary' : 'secondary'}
            className={o.allow ? undefined : 'island-deny'}
            disabled={card.answering !== null}
            onClick={() => model.respond(card, o.id)}
          >
            {card.answering === o.id ? <Spinner size={12} /> : null}
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function Finished({ model, bot }: { model: IslandModel; bot: IslandBot }) {
  return (
    <button className="island-row" onClick={() => model.openBot(bot.ref)} title="Open conversation">
      <Avatar bot={bot} size={24} />
      <span className="island-text">
        <span className="island-name">{bot.status === 'error' ? `${bot.name} failed` : `${bot.name} is done`}</span>
        <span className="island-detail">{bot.detail}</span>
      </span>
    </button>
  )
}

function Avatar({ bot, size }: { bot: IslandBot; size: number }) {
  const mood = bot.status === 'needsInput' ? 'needsInput' : bot.status === 'working' ? 'working' : 'idle'
  return <CharacterAvatar shape={bot.shape} color={bot.color} size={size} mood={mood} dark />
}

function Status({ bot }: { bot: IslandBot }) {
  switch (bot.status) {
    case 'working':
      return <ThinkingOrb size={14} color={INK} />
    case 'needsInput':
      return <span className="island-dot" />
    case 'error':
      return <span className="island-dot error" />
    default:
      return null
  }
}
