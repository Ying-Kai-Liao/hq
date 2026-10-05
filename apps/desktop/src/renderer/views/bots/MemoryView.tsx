import { useCallback, useEffect, useState } from 'react'
import { CardSection } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { Dialog } from '../../components/Overlay'
import { useStore } from '../../store/context'
import './bots.css'

/** One remembered fact (host `memory` API). */
interface MemoryFact {
  id: string
  content: string
  createdAt: number
  /** `profile` (who the user is) or `log` (dated history). */
  kind: string
}

/**
 * What the bot remembers about the user, in the bot's settings. Facts are
 * learned after each exchange and survive new sessions; remove any here.
 */
export function MemoryCard({ botId }: { botId: string }) {
  const store = useStore()
  const client = store.client
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(async () => {
    if (!client) return
    try {
      setFacts((await client.call<{ location: string; facts: MemoryFact[] }>('memory', { botId })).facts)
    } catch {
      setFacts([])
    }
    setLoaded(true)
  }, [client, botId])

  useEffect(() => {
    void load()
  }, [load])

  const forget = (fact: MemoryFact) => {
    setFacts((list) => list.filter((f) => f.id !== fact.id))
    void client?.call('forgetMemory', { botId, id: fact.id }).catch(() => {}).then(load)
  }

  const clear = () => {
    setFacts([])
    void client?.call('clearMemory', { botId }).catch(() => {}).then(load)
  }

  return (
    <>
      <CardSection
        title="Memory"
        accessory={
          facts.length ? (
            <button className="press" style={{ display: 'flex', color: 'var(--secondary)' }} title="Forget everything" aria-label="Forget everything" onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={12} />
            </button>
          ) : null
        }
      >
        {facts.length ? null : (
          <span style={{ color: 'var(--secondary)' }}>{loaded ? 'Nothing yet. The bot remembers who you are and what you work on as you chat.' : 'Loading…'}</span>
        )}
        {facts.map((fact) => (
          <div key={fact.id} className="fade-in" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ display: 'flex' }} title={fact.kind === 'profile' ? 'About you' : 'History'}>
              <Icon name={fact.kind === 'profile' ? 'person' : 'clock'} size={10} color="var(--tertiary)" />
            </span>
            <span className="selectable" style={{ flex: 1, minWidth: 0, color: 'var(--text)' }}>{fact.content}</span>
            <button className="press" style={{ display: 'flex', color: 'var(--tertiary)' }} title="Forget" aria-label="Forget" onClick={() => forget(fact)}>
              <Icon name="xmark" size={10} />
            </button>
          </div>
        ))}
      </CardSection>
      <Dialog
        open={confirmClear}
        title="Forget everything this bot remembers?"
        actions={[{ title: 'Forget everything', destructive: true, action: clear }]}
        onClose={() => setConfirmClear(false)}
      />
    </>
  )
}
