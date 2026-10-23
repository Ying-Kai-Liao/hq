import { avatarImage, DEFAULT_IMAGE } from '@shared/crew'
import { highlight, type CrewHit, type CrewResults } from '@shared/crew-search'
import { isGroup, type Bot } from '@shared/models'
import { BotAvatar } from '../../components/kith'
import { messagePreview } from '../../lib/message-preview'

const isMac = window.kith.platform === 'darwin'
const modifier = isMac ? '⌘' : 'Ctrl+'

/** The query's matches, marked soft yellow. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) => (part.hit ? <mark key={i} className="cs-mark">{part.text}</mark> : part.text))}
    </>
  )
}

/**
 * The list turned into results in place: Agents, Groups, Threads. "Search the crew's memory" and "Ask the crew" are
 * left out: nothing on this desktop backs them yet.
 */
export function SearchResults({ results, query, active, bots, onActive, open }: {
  results: CrewResults
  query: string
  /** The row Return opens. */
  active: number
  bots: (hit: CrewHit) => Bot | undefined
  onActive: (index: number) => void
  open: (hit: CrewHit) => void
}) {
  const sections: [string, CrewHit[]][] = [
    ['Agents', results.agents],
    ['Groups', results.groups],
    ['Threads', results.threads],
  ]
  let index = 0
  const total = results.agents.length + results.groups.length + results.threads.length
  if (!total) return <div className="cs-board-empty">No matches for “{query.trim()}”.</div>
  return (
    <div className="cs-results" role="listbox" aria-label="Search results">
      {sections.map(([label, hits]) =>
        hits.length ? (
          <section key={label} className="cs-section" aria-label={label}>
            <h3 className="cs-section-title">
              <span>{label}</span>
            </h3>
            {hits.map((hit) => {
              const i = index++
              const bot = bots(hit)
              return (
                <button
                  key={hit.key}
                  role="option"
                  aria-selected={i === active}
                  className={`cs-card cs-result ${i === active ? 'selected' : ''}`}
                  onMouseMove={() => i !== active && onActive(i)}
                  onClick={() => open(hit)}
                >
                  <span className="cs-card-face">
                    {bot ? <BotAvatar face={isGroup(bot) ? 'group' : (avatarImage(bot) ?? DEFAULT_IMAGE)} color={bot.avatarColor} id={bot.id} size={24} animated={false} /> : null}
                  </span>
                  <span className="cs-card-text">
                    <b><Marked text={hit.title} query={query} /></b>
                    <small>{hit.kind === 'thread' ? hit.room : bot ? messagePreview(bot.lastMessage ?? bot.description) : ''}</small>
                  </span>
                  {i < 9 ? <span className="cs-key">{`${modifier}${i + 1}`}</span> : null}
                </button>
              )
            })}
          </section>
        ) : null,
      )}
    </div>
  )
}
