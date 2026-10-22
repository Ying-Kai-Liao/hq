import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ago, cronWords, formatUsd, lastRunText, packageNotes, shortVersion, splitRoleSections, topModels,
  type KithInfo, type KithMcp, type KithSchedule, type KithSkill,
} from '@shared/kith-info'
import { Button, Disclosure, IconButton, Pill, Spinner } from '../../../components/Controls'
import { MarkdownText } from '../../thread/Markdown'
import type { KithInfoStore } from '../../../store/kith-info-store'
import './kith.css'

/** "kith · house" and the package chip, under the bot's name. */
export function KithHeader({ agent, kith }: { agent: string; kith: KithInfoStore }) {
  if (kith.unsupported) return null
  const pkg = kith.info?.package
  const version = shortVersion(pkg?.version)
  return (
    <span className="kith-header">
      <span>kith · {agent}</span>
      {pkg && version ? <Pill outlined className="kith-chip"><span title={packageNotes(pkg).join('\n') || undefined}>v{version}{pkg.dirty ? ' •' : ''}</span></Pill> : null}
    </span>
  )
}

/** The Kith sections of a bot's details, from `about` to skills; the bot editor's settings follow them. */
export function KithDetails({ kith }: { kith: KithInfoStore }) {
  if (kith.unsupported) return null
  const { info } = kith
  if (!info) {
    if (kith.error) return <Banner message={kith.error} loading={kith.loading} retry={() => void kith.load(true)} />
    return <p className="kith-muted kith-loading" role="status"><Spinner size={12} /> Loading details…</p>
  }
  const unread = (key: string) => info.errors[key] !== undefined
  return (
    <>
      <div className="kith-refresh">
        <span className="kith-muted">{kith.fetchedAt ? `Read ${ago(kith.fetchedAt)}` : ''}</span>
        {kith.loading ? <Spinner size={12} /> : <IconButton title="Refresh details" icon="arrow.clockwise" onClick={() => void kith.load(true)} />}
      </div>
      <About info={info} failed={unread('role')} />
      <Cost info={info} failed={unread('cost')} />
      {info.errors.schedules !== undefined || info.schedules.length ? <Schedules schedules={info.schedules} failed={unread('schedules')} /> : null}
      {info.errors.projects !== undefined || info.projects.length ? <Projects info={info} failed={unread('projects')} /> : null}
      <ModelAndPermissions info={info} />
      <Lists info={info} />
    </>
  )
}

function Banner({ message, loading, retry }: { message: string; loading: boolean; retry: () => void }) {
  return (
    <div className="kith-banner" role="alert">
      <span>Kith details unavailable: {message}</span>
      <Button kind="secondary" disabled={loading} onClick={retry}>{loading ? 'Retrying…' : 'Retry'}</Button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="details-section">
      <span className="details-section-title">{title}</span>
      {children}
    </section>
  )
}

const Failed = ({ what }: { what: string }) => <p className="kith-muted kith-failed">Couldn't read {what}</p>

/** Long markdown stops at about four lines until "More". */
function Clamped({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Measured while clamped: "More" only shows when four lines don't hold it.
  useLayoutEffect(() => {
    const el = box.current
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1)
  }, [text, open])
  return (
    <div className="kith-clamped">
      <div ref={box} className={open ? undefined : 'kith-clamp'}><MarkdownText text={text} /></div>
      {long ? <button className="kith-link press" onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button> : null}
    </div>
  )
}

function About({ info, failed }: { info: KithInfo; failed: boolean }) {
  const sections = info.role ? splitRoleSections(info.role.sections) : { notYours: [], rest: [] }
  return (
    <>
      <Section title="About">
        <div className="outlined-card kith-card">
          {failed ? <Failed what="the role" /> : <>
            {info.description ? <p className="kith-description">{info.description}</p> : null}
            {info.role?.intro ? <Clamped text={info.role.intro} /> : null}
            {sections.rest.map((s) => <RoleRow key={s.title} title={s.title} text={s.text} />)}
          </>}
        </div>
      </Section>
      {sections.notYours.map((s) => (
        <Section key={s.title} title="Not this bot's job">
          <div className="outlined-card kith-card"><MarkdownText text={s.text} /></div>
        </Section>
      ))}
    </>
  )
}

function RoleRow({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Disclosure expanded={open} onToggle={() => setOpen(!open)} label={<span className="kith-row-title">{title}</span>}>
      <MarkdownText text={text} />
    </Disclosure>
  )
}

function Cost({ info, failed }: { info: KithInfo; failed: boolean }) {
  const cost = info.cost
  return (
    <Section title="Cost">
      <div className="outlined-card kith-card">
        {failed ? <Failed what="the cost" /> : !cost ? <p className="kith-muted">No cost recorded yet</p> : <>
          <div className="kith-stats">
            {([['Today', cost.today], ['7 days', cost.week], ['30 days', cost.month], ['All', cost.all]] as const).map(([label, usd]) => (
              <div key={label} className="kith-stat"><strong>{formatUsd(usd)}</strong><small>{label}</small></div>
            ))}
          </div>
          <p className="kith-muted">{cost.requestsMonth} {cost.requestsMonth === 1 ? 'request' : 'requests'} in 30 days</p>
          {topModels(cost).map((m) => (
            <div key={m.model} className="kith-model">
              <span className="kith-ellipsis" title={m.model}>{m.model}</span>
              <span className="kith-muted">{formatUsd(m.usd)} · {Math.round(m.share * 100)}%</span>
            </div>
          ))}
        </>}
      </div>
    </Section>
  )
}

function Schedules({ schedules, failed }: { schedules: KithSchedule[]; failed: boolean }) {
  return (
    <Section title="Schedules">
      <div className="outlined-card kith-card">
        {failed ? <Failed what="the schedules" /> : schedules.map((s) => <ScheduleRow key={s.id} schedule={s} />)}
      </div>
    </Section>
  )
}

function ScheduleRow({ schedule: s }: { schedule: KithSchedule }) {
  const [open, setOpen] = useState(false)
  const last = lastRunText(s)
  return (
    <div className="kith-schedule">
      <button className={`kith-task press${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title={open ? undefined : s.task}>
        {s.task || s.id}
      </button>
      <div className="kith-meta">
        <span>{cronWords(s.cron)}</span>
        {s.paused ? <Pill outlined className="kith-badge">Paused</Pill> : null}
        {last ? <span>{last === 'running' ? 'running' : `last ${last}`}</span> : null}
        {s.nextRun !== null && !s.paused ? <span>next {new Date(s.nextRun).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> : null}
      </div>
    </div>
  )
}

function Projects({ info, failed }: { info: KithInfo; failed: boolean }) {
  return (
    <Section title="Projects">
      <div className="outlined-card kith-card">
        {failed ? <Failed what="the projects" /> : info.projects.map((p) => (
          <div key={p.id} className="kith-model">
            <span className="kith-ellipsis" title={p.id}>{p.id}</span>
            <span className="kith-muted">{p.files} {p.files === 1 ? 'file' : 'files'}{p.modified !== null ? ` · ${ago(p.modified)}` : ''}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ModelAndPermissions({ info }: { info: KithInfo }) {
  const rows: [string, string | null][] = [
    ['Model', info.model], ['Effort', info.effort], ['Permission', info.permissionMode], ['Harness', info.harness],
    ['Read-only', info.readOnly ? 'yes' : null],
  ]
  const shown = rows.filter(([, v]) => v)
  if (!shown.length) return null
  return (
    <Section title="Model & permissions">
      <div className="outlined-card kith-card">
        {shown.map(([label, value]) => (
          <div key={label} className="kith-model"><span>{label}</span><span className="kith-muted">{value}</span></div>
        ))}
        <small className="kith-muted">Set in the agent's package</small>
      </div>
    </Section>
  )
}

/** Skills, tools, MCP servers and plugins: a collapsed group each, with its count. */
function Lists({ info }: { info: KithInfo }) {
  const group = (key: string, title: string, count: number, body: ReactNode) => (
    info.errors[key] !== undefined || count > 0 ? <Group key={key} title={title} count={info.errors[key] !== undefined ? null : count}>{info.errors[key] !== undefined ? <Failed what={title.toLowerCase()} /> : body}</Group> : null
  )
  return (
    <Section title="Skills, tools & MCP">
      <div className="outlined-card kith-card">
        {group('skills', 'Skills', info.skills.length, info.skills.map((s) => <SkillRow key={s.name} skill={s} />))}
        {group('tools', 'Tools', info.tools.length, info.tools.map((t) => <div key={t} className="kith-item kith-ellipsis" title={t}>{t}</div>))}
        {group('mcp_servers', 'MCP servers', info.mcpServers.length, info.mcpServers.map((m) => <McpRow key={m.name} server={m} />))}
        {group('plugins', 'Plugins', info.plugins.length, info.plugins.map((t) => <div key={t} className="kith-item kith-ellipsis" title={t}>{t}</div>))}
        {!info.skills.length && !info.tools.length && !info.mcpServers.length && !info.plugins.length && !Object.keys(info.errors).length
          ? <p className="kith-muted">Nothing set up</p> : null}
      </div>
    </Section>
  )
}

function Group({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Disclosure expanded={open} onToggle={() => setOpen(!open)} label={<span className="kith-row-title">{title}{count !== null ? <span className="kith-muted"> · {count}</span> : null}</span>}>
      <div className="kith-group">{children}</div>
    </Disclosure>
  )
}

function SkillRow({ skill }: { skill: KithSkill }) {
  return (
    <div className="kith-item">
      <div className="kith-skill-head">
        <strong className="kith-ellipsis">{skill.name}</strong>
        {skill.source === 'learned' || skill.source === 'global' ? <Pill outlined className="kith-badge">{skill.source}</Pill> : null}
      </div>
      {skill.description ? <p className="kith-muted kith-skill-desc" title={skill.description}>{skill.description}</p> : null}
    </div>
  )
}

function McpRow({ server }: { server: KithMcp }) {
  const where = server.command ?? server.url ?? ''
  return (
    <div className="kith-item">
      <div className="kith-skill-head"><strong className="kith-ellipsis">{server.name}</strong>{server.kind ? <Pill outlined className="kith-badge">{server.kind}</Pill> : null}</div>
      {where ? <p className="kith-muted kith-ellipsis" title={where}>{where}</p> : null}
    </div>
  )
}
