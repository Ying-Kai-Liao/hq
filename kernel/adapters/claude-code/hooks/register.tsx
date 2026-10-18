import type { EngineInterface, Register } from 'claude-code'

// Claude Code adapter for hq. The kernel (bin/, PROTOCOL.md) lives in the hq repo; the installed agents in the
// agents folder (<hq>/agents/<name>/role, each its own git repo, next to the agent's memory, data and files; listed by bin/hq-pkg); this plugin only reads them:
//   session.start      register every installed agent's agent.md as `hq:<name>`, pinned for this session to the
//                      package version bin/hq-pkg resolves (edits made meanwhile apply to the next session)
//   agent.spawn        resolve the project, prepend it and the agent's memory to the task
//   turn.step          the agent's `effort:` (agent.md frontmatter) on its model requests; `model:` is set at register
//   classic.SubagentStop  nudge once if the agent didn't write its session file
//   /hq, mcp__hq__invoke  list agents; call one with an explicit project
// The kernel comes from hq_path (default ~/hq/kernel, else ~/.hq/kernel, else ~/Workspace/hq); agents and state from the resolver, as every
// kernel tool finds them (lib/hq_paths.py).

type Spawned = { agent: string; project: string; startedMs: number; isNudged: boolean }

const spawned = new Map<string, Spawned>()
// Reasoning effort per hq agent (from agent.md) and per running hq subagent. A spawn has no effort field, so
// agent.spawn notes the agent and turn.step applies it to that agent's requests.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const agentEffort = new Map<string, string>()
const runningEffort = new Map<string, string>()

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  return { fields, body: text.slice(m[0].length) }
}

async function hqRoot($: EngineInterface, configured: unknown): Promise<string> {
  const set = typeof configured === 'string' ? configured.trim() : ''
  const home = (await $.env.get('HOME')) ?? ''
  if (set) return set.replace(/^~(?=\/)/, home)
  // ~/hq/kernel is where install.sh puts it; ~/.hq/kernel and ~/Workspace/hq are where older installs have it.
  for (const k of [`${home}/hq/kernel`, `${home}/.hq/kernel`]) if (await $.fs.exists(`${k}/bin/hq-pkg`)) return k
  return `${home}/Workspace/hq`
}

// Where things are, from the kernel's one resolver (lib/hq_paths.py): the state folder (~/.hq) and
// agents/, each as an address and with symlinks resolved (_REAL, what permission rules are matched against).
async function hqPaths($: EngineInterface, hq: string): Promise<Record<string, string>> {
  const run = await $.process.run(['/usr/bin/python3', `${hq}/lib/hq_paths.py`, '--json'], { timeoutMs: 10_000 })
  try {
    if (run.exitCode === 0) return JSON.parse(run.stdout) as Record<string, string>
  } catch {}
  return { HQ_STATE: `${hq}/state`, HQ_AGENTS: `${hq}/agents`, HQ_STATE_REAL: `${hq}/state`, HQ_AGENTS_REAL: `${hq}/agents` }
}

// Helpers that take $ must be top-level functions: the hooks loader refuses the whole module otherwise.

// Installed agents, {name: package folder}: the agents folder first, then the repo's own agents/ (older installs).
async function listAgents($: EngineInterface, hq: string): Promise<Record<string, string>> {
  const run = await $.process.run([`${hq}/bin/hq-pkg`, 'list', '--json'], { timeoutMs: 30_000 })
  try {
    const out = run.exitCode === 0 ? (JSON.parse(run.stdout) as Record<string, { dir: string }>) : {}
    return Object.fromEntries(Object.entries(out).map(([name, o]) => [name, o.dir]))
  } catch {
    return {}
  }
}

// One call pins every agent: {name: {dir, version, note}}. Empty when hq-pkg fails; agents then run live.
async function resolvePackages($: EngineInterface, hq: string): Promise<Record<string, { dir: string; note: string }>> {
  const run = await $.process.run([`${hq}/bin/hq-pkg`, 'resolve', '--all', '--json'], { timeoutMs: 30_000 })
  try {
    return run.exitCode === 0 ? (JSON.parse(run.stdout) as Record<string, { dir: string; note: string }>) : {}
  } catch {
    return {}
  }
}

// One line on where this session sits among the user's projects (bin/project-id --info, --children), or '' for a
// project with no parent, home or children. In a repo: its parents and their files. At a parent: what it holds.
async function projectContext($: EngineInterface, hq: string, cwd: string): Promise<string> {
  const run = async (...args: string[]) => {
    const r = await $.process.run([`${hq}/bin/project-id`, ...args], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  }
  const id = await run(cwd)
  if (!id) return ''
  const rows = (out: string | null) => (out ? out.split('\n').map((l) => l.split('\t')) : [])
  const chain = rows(await run('--info', id))
  const held = rows(await run('--children', id))
  const homes = chain.filter(([, h]) => h && h !== '-').map(([p, h]) => `${p}: ${h}`)
  if (chain.length < 2 && !homes.length && !held.length) return ''
  const parents = chain.slice(1).map(([p]) => p)
  return (
    `hq project: ${id}` + (parents.length ? `, part of ${parents.join(' → ')}` : '') + '.' +
    (held.length
      ? ` It holds ${held.map(([c, d]) => `${c} (${d === '-' ? 'not on this Mac' : d})`).join(', ')}.`
      : '') +
    (homes.length ? ` The user's own files for it (specs, briefs, contracts): ${homes.join('; ')}.` : '') +
    (parents.length
      ? ' Open the parent\'s files only when the task needs more than this project; `hq project` shows the rest.'
      : ' `hq project` shows the rest.')
  )
}

export const register: Register = (on, options) => {

  // agentDir: the pinned snapshot from hq-pkg (or the live folder when versioning is unavailable).
  // state: the state folder; stateReal: the same with symlinks resolved ({{HOME_REAL}}, used by permission rules).
  let state = ''
  let stateReal = ''
  let userHome = ''
  let agentsRoot = ''
  let machine = ''
  let installed: Record<string, string> = {}
  let agentsReal = ''
  let projectLine = ''
  // An agent's life (memory, data, files): its folder next to role/; older layouts: <state>/agents/<name>.
  const lifeOf = (agent: string, hq: string, real = false) => {
    const dir = installed[agent]
    if (dir?.endsWith('/role')) return real && agentsReal ? `${agentsReal}/${agent}` : dir.slice(0, -'/role'.length)
    return `${(real && stateReal) || state || hq}/agents/${agent}`
  }
  const fill = (text: string, hq: string, agent: string, agentDir = installed[agent] ?? `${hq}/agents/${agent}`) =>
    text
      .replaceAll('{{AGENT_DIR}}', agentDir)
      .replaceAll('{{AGENTS}}', agentsRoot || `${state || hq}/packages`)
      .replaceAll('{{PACKAGE}}', installed[agent] ?? `${hq}/agents/${agent}`)
      .replaceAll('{{HOME_DIR}}', lifeOf(agent, hq))
      .replaceAll('{{HOME_REAL}}', lifeOf(agent, hq, true))
      .replaceAll('{{STATE}}', state || hq)
      .replaceAll('{{MACHINE}}', machine || `${userHome}/.hq`)
      .replaceAll('{{USER_HOME}}', userHome)
      .replaceAll('{{HQ}}', hq)
      .replaceAll('{{AGENT}}', agent)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const hq = await hqRoot($, options.hq_path)
    if (!(await $.fs.exists(`${hq}/bin/hq-pkg`))) {
      $.ui.toast(`hq: no hq repo at ${hq}; set hq_path in /plugin config`)
      return result
    }
    const protocol = await $.fs.read(`${hq}/PROTOCOL.md`)
    const where = await hqPaths($, hq)
    state = where.HQ_STATE
    stateReal = where.HQ_STATE_REAL
    agentsRoot = where.HQ_AGENTS
    machine = where.HQ_MACHINE ?? ''
    agentsReal = where.HQ_AGENTS_REAL
    installed = await listAgents($, hq)
    userHome = (await $.env.get('HOME')) ?? ''
    projectLine = await projectContext($, hq, e.cwd)
    const packages = await resolvePackages($, hq)
    for (const [name, dir] of Object.entries(installed)) {
      const file = `${dir}/agent.md`
      if (!(await $.fs.exists(file))) continue
      const pkg = packages[name]
      // The pinned agent.md, so model and effort change with the version like everything else.
      const pinned = pkg && (await $.fs.exists(`${pkg.dir}/agent.md`)) ? `${pkg.dir}/agent.md` : file
      const { fields, body } = frontmatter(await $.fs.read(pinned))
      if (EFFORTS.has(fields.effort ?? '')) agentEffort.set(name, fields.effort)
      else agentEffort.delete(name)
      const rendered = pkg && (await $.fs.exists(`${pkg.dir}/prompt.md`)) ? await $.fs.read(`${pkg.dir}/prompt.md`) : ''
      await $.agent.register({
        name,
        description: fields.description ?? `hq specialist: ${name}`,
        prompt: rendered
          ? fill(rendered, hq, name, pkg.dir)
          : `${fill(body, hq, name)}\n${fill(protocol, hq, name)}`,
        ...(fields.model ? { model: fields.model } : {}),
      })
    }
    await $.command.register({
      name: 'hq',
      description: 'hq specialists: list them, or delegate a task (/hq <agent> [-p project] <task>)',
      argumentHint: '[agent] [-p project] [task]',
    })
    await $.tool.register({
      name: 'invoke',
      description:
        'Call an hq specialist (persistent agent with its own memory) on a task. ' +
        'Give `project` when the work is for a known project that the current directory does not belong to.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name, e.g. branding' },
          task: { type: 'string', description: 'What to do' },
          project: { type: 'string', description: 'Project ID from projects.json (optional)' },
        },
        required: ['agent', 'task'],
      },
    })
    return result
  })

  // Every hq spawn, whoever starts it: project + fresh long-term memory go in front of the task.
  // A session in a project that sits in a parent, or has a home, is told so in one line; nothing for any other.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!projectLine) return result
    return { sections: [...result.sections, { id: 'hq:project', text: projectLine, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (!e.subagentType.startsWith('hq:')) return next(e)
    const hq = await hqRoot($, options.hq_path)
    const agent = e.subagentType.slice(3)
    const cwd = e.cwd ?? (await $.session.cwd())

    // A run for someone other than the owner (HQ_PERSON, from bin/hq) may start only the helpers that person may
    // use, checked as this agent's helper. Fails closed: no answer from hq-auth, no spawn.
    const person = (await $.env.get('HQ_PERSON')) ?? ''
    if (person) {
      const caller = (await $.env.get('HQ_AGENT')) ?? ''
      let why = ''
      try {
        const r = await $.process.run([`${hq}/bin/hq-auth`, 'may', person, agent, ...(caller ? ['--via', caller] : [])],
          { timeoutMs: 10_000 })
        if (r.exitCode !== 0) why = r.stdout.trim() || r.stderr.trim() || `${person} may not use ${agent}`
      } catch {
        why = `can't check whether ${person} may use ${agent}`
      }
      if (why) return { deny: `hq: ${why}. This run is for ${person}; only the owner can give them ${agent}.` }
    }

    const named = /^<hq project="([a-z0-9][a-z0-9._-]*)"\/>\n?/.exec(e.prompt)
    let project = named?.[1] ?? ''
    if (!project) {
      const found = await $.process.run([`${hq}/bin/project-id`, cwd], { timeoutMs: 10_000 })
      project = found.exitCode === 0 ? found.stdout.trim() : ''
    }
    const task = named ? e.prompt.slice(named[0].length) : e.prompt
    // The project's parents, closest first (bin/project-id --info): agents read their memory too.
    const info = project ? await $.process.run([`${hq}/bin/project-id`, '--info', project], { timeoutMs: 10_000 }) : null
    const parents = info?.exitCode === 0
      ? info.stdout.trim().split('\n').slice(1).map((l) => l.split('\t')[0]).join(' ')
      : ''
    if (!state) state = (await hqPaths($, hq)).HQ_STATE
    const memoryFile = `${lifeOf(agent, hq)}/memory/MEMORY.md`
    const memory = (await $.fs.exists(memoryFile)) ? await $.fs.read(memoryFile) : ''
    const today = new Date().toISOString().slice(0, 10)

    const prompt =
      `<session project="${project || 'none'}"${parents ? ` parents="${parents}"` : ''} cwd="${cwd}" date="${today}"/>\n` +
      `<long-term-memory path="${memoryFile}">\n${memory}\n</long-term-memory>\n\n${task}`

    const started = await next({ ...e, prompt })
    if (started.agentId) {
      spawned.set(started.agentId, { agent, project, startedMs: Date.now(), isNudged: false })
      const effort = agentEffort.get(agent)
      if (effort) runningEffort.set(started.agentId, effort)
    }
    return started
  }).catch(($, e, next) => next(e)) // never block a spawn because of hq

  // Only requests that carry an effort (the model supports it) get the agent's.
  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId !== undefined ? runningEffort.get(e.agentId) : undefined
    if (effort === undefined || e.effort === undefined) return yield* next(e)
    return yield* next({ ...e, effort: effort as typeof e.effort })
  })

  // The session file is how the next call picks up; ask once if it wasn't written.
  on('classic.SubagentStop', async ($, e, next) => {
    const run = spawned.get(e.agent_id)
    if (!run || !run.project || run.isNudged || e.stop_hook_active) return next(e)
    const hq = await hqRoot($, options.hq_path)
    if (!state) state = (await hqPaths($, hq)).HQ_STATE
    const file = `${lifeOf(run.agent, hq)}/memory/sessions/${run.project}.md`
    const isWritten = (await $.fs.exists(file)) && (await $.fs.stat(file)).mtimeMs >= run.startedMs
    if (isWritten) {
      spawned.delete(e.agent_id)
      runningEffort.delete(e.agent_id)
      return next(e)
    }
    run.isNudged = true
    return {
      block:
        `Before you finish: write ${file} (task, state, next step, open questions; max 30 lines), ` +
        'append any decisions, and update project or long-term memory if you learned something durable.',
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'hq' }, async ($, e) => {
    const hq = await hqRoot($, options.hq_path)
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (!Object.keys(installed).length) installed = await listAgents($, hq)
    const agents = Object.keys(installed).sort()

    if (words.length === 0) {
      const project = await $.process.run([`${hq}/bin/project-id`, await $.session.cwd()])
      return {
        text:
          `hq agents: ${agents.join(', ')}\n` +
          `project here: ${project.exitCode === 0 ? project.stdout.trim() : 'none'}\n` +
          'Delegate with /hq <agent> [-p project] <task>.',
      }
    }

    const [agent, ...rest] = words
    if (!agents.includes(agent)) return { text: `hq: no agent '${agent}'. Agents: ${agents.join(', ')}` }
    let project = ''
    if (rest[0] === '-p') {
      project = rest[1] ?? ''
      rest.splice(0, 2)
    }
    const task = rest.join(' ')
    if (!task) return { text: `hq: what should ${agent} do? /hq ${agent} [-p project] <task>` }
    return {
      context: [
        `The user asked to delegate this to the hq specialist \`hq:${agent}\`. Call the Agent tool with ` +
          `subagent_type "hq:${agent}" and this prompt, word for word:\n\n` +
          (project ? `<hq project="${project}"/>\n` : '') +
          task +
          '\n\nWhen it reports back, relay what it did and anything it needs from the user.',
      ],
    }
  })

  on('tool.call', { tool: 'mcp__hq__invoke' }, async ($, e) => {
    const input = e as unknown as { agent: string; task: string; project?: string }
    const prompt = (input.project ? `<hq project="${input.project}"/>\n` : '') + input.task
    const started = await $.agent.spawn({
      subagentType: `hq:${input.agent}`,
      description: `hq ${input.agent}`,
      prompt,
    })
    return {
      result: started.deny
        ? `hq: could not start ${input.agent}: ${started.deny}`
        : `hq:${input.agent} started (agent ${started.agentId}); its report arrives when it finishes.`,
    }
  }).catch(() => ({ result: 'hq: invoke failed inside the hq plugin.' }))
}
