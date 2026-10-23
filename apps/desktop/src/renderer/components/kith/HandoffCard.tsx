import { Icon } from '../Icon'
import './kith.css'

/** What a bot's chat carries over. Every field is optional: a row shows only when its field is real. */
export interface HandoffFields {
  /** What was done / where it stopped. */
  leftOff?: string
  /** What comes next. */
  next?: string
  /** What it is waiting on. */
  waitingOn?: string
  /** When, already formatted ("Yesterday 17:40"). */
  when?: string
  /** The thread or task it was in. */
  place?: string
}

const ROWS: [keyof HandoffFields, string, string][] = [
  ['leftOff', 'Left off', 'arrow.triangle.branch'],
  ['next', 'Next', 'arrow.right'],
  ['waitingOn', 'Waiting on', 'clock'],
  ['place', 'In', 'folder'],
]

/** "Where we left off": a quiet card (radius 18) with the fields the host actually has. Nothing real, nothing drawn. */
export function HandoffCard({ fields, title = 'Where we left off', onOpen }: { fields: HandoffFields; title?: string; onOpen?: () => void }) {
  const rows = ROWS.filter(([k]) => !!fields[k]?.trim())
  if (!rows.length) return null
  return (
    <section className="kc-handoff" aria-label={title}>
      <header className="kc-handoff-head">
        <span className="kith-text-label">{title.toUpperCase()}</span>
        {fields.when ? <span className="kith-text-secondary kc-handoff-when">{fields.when}</span> : null}
      </header>
      {rows.map(([k, label, icon]) => (
        <div className="kc-handoff-row" key={k}>
          <span className="kc-handoff-key kith-text-secondary">
            <Icon name={icon} size={11} />
            {label}
          </span>
          <span className="kc-handoff-value kith-text-body">{fields[k]}</span>
        </div>
      ))}
      {onOpen ? (
        <button className="kc-link kith-text-secondary" onClick={onOpen}>
          Open thread
        </button>
      ) : null}
    </section>
  )
}
