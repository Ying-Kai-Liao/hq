import { Button } from '../../components/Controls'
import { Icon } from '../../components/Icon'
import { useApp } from '../../store/context'
import { OPEN_INVITE_LINK } from '../../store/relay-macs'
import type { MacRow } from '../../store/mac-list'
import { macProblem, type MacProblem } from '../../lib/mac-problem'
import { useModel } from '../../lib/observable'
import { relativeDay } from './parts'

/** One card per Mac that needs the person (offline, unreachable, access removed); none otherwise. */
export function MacProblemCards({ rows, shown }: { rows: MacRow[]; shown: string[] }) {
  return (
    <>
      {rows.map((row) => (
        <MacProblemCard key={row.id} row={row} shown={shown.includes(row.id)} />
      ))}
    </>
  )
}

function MacProblemCard({ row, shown }: { row: MacRow; shown: boolean }) {
  const app = useApp()
  const macs = app.relayMacs
  const store = macs.store(row.id) ?? null
  useModel(store)
  const connection = store?.shownConnection
  const problem = connection
    ? macProblem(
        row.name,
        {
          kind: row.kind,
          shown,
          hasStore: true,
          action: row.action,
          mismatch: store?.mismatch != null,
          openInvite: connection.kind === 'offline' && connection.message === OPEN_INVITE_LINK,
          connection,
        },
        (ms) => relativeDay(new Date(ms)),
      )
    : null
  if (!problem) return null
  return <ProblemRow problem={problem} onAct={() => (problem.button === 'forget' ? void macs.disconnect(row.id) : macs.reconnect(row.id))} />
}

function ProblemRow({ problem, onAct }: { problem: MacProblem; onAct: () => void }) {
  return (
    <div className="settings-problem" role="group" aria-label={`${problem.title}. ${problem.detail}`}>
      <Icon name={problem.icon} size={22} color="var(--secondary)" />
      <div className="settings-problem-text">
        <div className="settings-problem-title">{problem.title}</div>
        <div className="settings-problem-detail">{problem.detail}</div>
      </div>
      <Button onClick={onAct}>{problem.button === 'forget' ? 'Forget' : 'Reconnect'}</Button>
    </div>
  )
}
