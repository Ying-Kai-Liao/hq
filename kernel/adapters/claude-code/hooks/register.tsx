import type { EngineInterface, Register } from 'claude-code'

// Claude Code adapter for kith. The kernel (bin/, PROTOCOL.md) lives in the kith repo; the installed agents in the
// agents folder (<kith>/agents/<name>/role, each its own git repo, next to the agent's memory, data and files; listed by bin/kith-pkg); this plugin only reads them:
//   session.start      register every installed agent's agent.md as `kith:<name>`, pinned for this session to the
//                      package version bin/kith-pkg resolves (edits made meanwhile apply to the next session)
//   agent.spawn        resolve the project, prepend it and the agent's memory to the task
//   turn.step          the agent's `effort:` (agent.md frontmatter) on its model requests; `model:` is set at register
//   classic.SubagentStop  nudge once if the agent didn't write its session file
//   /kith, mcp__kith__invoke  list agents; call one with an explicit project
// The kernel comes from kith_path (default ~/kith/kernel, else ~/hq/kernel, ~/.kith/kernel, ~/Workspace/kith); agents and state from the resolver, as every
// kernel tool finds them (lib/kith_paths.py).

type Spawned = { agent: string; project: string; startedMs: number; isNudged: boolean }

const spawned = new Map<string, Spawned>()
// Reasoning effort per kith agent (from agent.md) and per running kith subagent. A spawn has no effort field, so
// agent.spawn notes the agent and turn.step applies it to that agent's requests.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const agentEffort = new Map<string, string>()
const runningEffort = new Map<string, string>()
// Agents that run as one long-lived session (`session: live` in agent.md): never a subagent here, since a subagent
// runs with the caller's settings and permission mode, outside the agent's own session. Reached with `kith ask`.
const liveAgents = new Set<string>()

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

async function kithRoot($: EngineInterface, configured: unknown): Promise<string> {
  const set = typeof configured === 'string' ? configured.trim() : ''
  const home = (await $.env.get('HOME')) ?? ''
  if (set) return set.replace(/^~(?=\/)/, home)
  // ~/kith/kernel is where install.sh puts it; ~/hq/kernel, ~/.kith/kernel, ~/.hq/kernel and ~/Workspace/kith are where older installs have it (hq_path is the config key before the rename).
  for (const k of [`${home}/kith/kernel`, `${home}/hq/kernel`, `${home}/.kith/kernel`, `${home}/.hq/kernel`]) if (await $.fs.exists(`${k}/bin/kith-pkg`)) return k
  return `${home}/Workspace/kith`
}

// Where things are, from the kernel's one resolver (lib/kith_paths.py): the state folder (~/.kith) and
// agents/, each as an address and with symlinks resolved (_REAL, what permission rules are matched against).
async function kithPaths($: EngineInterface, kith: string): Promise<Record<string, string>> {
  const run = await $.process.run(['/usr/bin/python3', `${kith}/lib/kith_paths.py`, '--json'], { timeoutMs: 10_000 })
  try {
    if (run.exitCode === 0) return JSON.parse(run.stdout) as Record<string, string>
  } catch {}
  return { KITH_STATE: `${kith}/state`, KITH_AGENTS: `${kith}/agents`, KITH_STATE_REAL: `${kith}/state`, KITH_AGENTS_REAL: `${kith}/agents` }
}

// Helpers that take $ must be top-level functions: the hooks loader refuses the whole module otherwise.

// Installed agents, {name: package folder}: the agents folder first, then the repo's own agents/ (older installs).
async function listAgents($: EngineInterface, kith: string): Promise<Record<string, string>> {
  const run = await $.process.run([`${kith}/bin/kith-pkg`, 'list', '--json'], { timeoutMs: 30_000 })
  try {
    const out = run.exitCode === 0 ? (JSON.parse(run.stdout) as Record<string, { dir: string }>) : {}
    return Object.fromEntries(Object.entries(out).map(([name, o]) => [name, o.dir]))
  } catch {
    return {}
  }
}

// One call pins every agent: {name: {dir, version, note}}. Empty when kith-pkg fails; agents then run live.
async function resolvePackages($: EngineInterface, kith: string): Promise<Record<string, { dir: string; note: string }>> {
  const run = await $.process.run([`${kith}/bin/kith-pkg`, 'resolve', '--all', '--json'], { timeoutMs: 30_000 })
  try {
    return run.exitCode === 0 ? (JSON.parse(run.stdout) as Record<string, { dir: string; note: string }>) : {}
  } catch {
    return {}
  }
}

// One line on where this session sits among the user's projects (bin/project-id --info, --children), or '' for a
// project with no parent, home or children. In a repo: its parents and their files. At a parent: what it holds.
async function projectContext($: EngineInterface, kith: string, cwd: string): Promise<string> {
  const run = async (...args: string[]) => {
    const r = await $.process.run([`${kith}/bin/project-id`, ...args], { timeoutMs: 10_000 })
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
    `kith project: ${id}` + (parents.length ? `, part of ${parents.join(' → ')}` : '') + '.' +
    (held.length
      ? ` It holds ${held.map(([c, d]) => `${c} (${d === '-' ? 'not on this Mac' : d})`).join(', ')}.`
      : '') +
    (homes.length ? ` The user's own files for it (specs, briefs, contracts): ${homes.join('; ')}.` : '') +
    (parents.length
      ? ' Open the parent\'s files only when the task needs more than this project; `kith project` shows the rest.'
      : ' `kith project` shows the rest.')
  )
}

// A live agent takes work as a message to its session: the caller runs kith ask, which delivers it there.
function liveAsk(kith: string, agent: string, task: string, project: string): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  return (
    `kith:${agent} runs as one live session (session: live), not as a subagent. Send it the task with the Bash tool:\n\n` +
    `${q(`${kith}/bin/kith`)} ask ${agent}${project ? ` -p ${project}` : ''} ${q(task)}\n\n` +
    'and relay what it answers.'
  )
}

export const register: Register = (on, options) => {

  // agentDir: the pinned snapshot from kith-pkg (or the live folder when versioning is unavailable).
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
  const lifeOf = (agent: string, kith: string, real = false) => {
    const dir = installed[agent]
    if (dir?.endsWith('/role')) return real && agentsReal ? `${agentsReal}/${agent}` : dir.slice(0, -'/role'.length)
    return `${(real && stateReal) || state || kith}/agents/${agent}`
  }
  const fill = (text: string, kith: string, agent: string, agentDir = installed[agent] ?? `${kith}/agents/${agent}`) =>
    text
      .replaceAll('{{AGENT_DIR}}', agentDir)
      .replaceAll('{{AGENTS}}', agentsRoot || `${state || kith}/packages`)
      .replaceAll('{{PACKAGE}}', installed[agent] ?? `${kith}/agents/${agent}`)
      .replaceAll('{{HOME_DIR}}', lifeOf(agent, kith))
      .replaceAll('{{HOME_REAL}}', lifeOf(agent, kith, true))
      .replaceAll('{{STATE}}', state || kith)
      .replaceAll('{{MACHINE}}', machine || `${userHome}/.kith`)
      .replaceAll('{{USER_HOME}}', userHome)
      .replaceAll('{{KITH}}', kith)
      .replaceAll('{{HQ}}', kith)   // role repos written before the rename
      .replaceAll('{{AGENT}}', agent)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const kith = await kithRoot($, (options.kith_path || options.hq_path))
    if (!(await $.fs.exists(`${kith}/bin/kith-pkg`))) {
      $.ui.toast(`kith: no kith repo at ${kith}; set kith_path in /plugin config`)
      return result
    }
    const protocol = await $.fs.read(`${kith}/PROTOCOL.md`)
    const where = await kithPaths($, kith)
    state = where.KITH_STATE
    stateReal = where.KITH_STATE_REAL
    agentsRoot = where.KITH_AGENTS
    machine = where.KITH_MACHINE ?? ''
    agentsReal = where.KITH_AGENTS_REAL
    installed = await listAgents($, kith)
    userHome = (await $.env.get('HOME')) ?? ''
    projectLine = await projectContext($, kith, e.cwd)
    const packages = await resolvePackages($, kith)
    for (const [name, dir] of Object.entries(installed)) {
      const file = `${dir}/agent.md`
      if (!(await $.fs.exists(file))) continue
      const pkg = packages[name]
      // The pinned agent.md, so model and effort change with the version like everything else.
      const pinned = pkg && (await $.fs.exists(`${pkg.dir}/agent.md`)) ? `${pkg.dir}/agent.md` : file
      const { fields, body } = frontmatter(await $.fs.read(pinned))
      if (fields.session === 'live') {
        liveAgents.add(name)
        continue
      }
      liveAgents.delete(name)
      if (EFFORTS.has(fields.effort ?? '')) agentEffort.set(name, fields.effort)
      else agentEffort.delete(name)
      const rendered = pkg && (await $.fs.exists(`${pkg.dir}/prompt.md`)) ? await $.fs.read(`${pkg.dir}/prompt.md`) : ''
      await $.agent.register({
        name,
        description: fields.description ?? `kith specialist: ${name}`,
        prompt: rendered
          ? fill(rendered, kith, name, pkg.dir)
          : `${fill(body, kith, name)}\n${fill(protocol, kith, name)}`,
        ...(fields.model ? { model: fields.model } : {}),
      })
    }
    await $.command.register({
      name: 'kith',
      description: 'kith specialists: list them, or delegate a task (/kith <agent> [-p project] <task>)',
      argumentHint: '[agent] [-p project] [task]',
    })
    await $.tool.register({
      name: 'invoke',
      description:
        'Call a kith specialist (persistent agent with its own memory) on a task. ' +
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

  // Every kith spawn, whoever starts it: project + fresh long-term memory go in front of the task.
  // A session in a project that sits in a parent, or has a home, is told so in one line; nothing for any other.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!projectLine) return result
    return { sections: [...result.sections, { id: 'kith:project', text: projectLine, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (!e.subagentType.startsWith('kith:')) return next(e)
    const kith = await kithRoot($, (options.kith_path || options.hq_path))
    const agent = e.subagentType.slice(5)   // after "kith:"
    const cwd = e.cwd ?? (await $.session.cwd())

    // A run for someone other than the owner (KITH_PERSON, from bin/kith) may start only the helpers that person may
    // use, checked as this agent's helper. Fails closed: no answer from kith-auth, no spawn.
    const person = (await $.env.get('KITH_PERSON')) ?? ''
    if (person) {
      const caller = (await $.env.get('KITH_AGENT')) ?? ''
      let why = ''
      try {
        const r = await $.process.run([`${kith}/bin/kith-auth`, 'may', person, agent, ...(caller ? ['--via', caller] : [])],
          { timeoutMs: 10_000 })
        if (r.exitCode !== 0) why = r.stdout.trim() || r.stderr.trim() || `${person} may not use ${agent}`
      } catch {
        why = `can't check whether ${person} may use ${agent}`
      }
      if (why) return { deny: `kith: ${why}. This run is for ${person}; only the owner can give them ${agent}.` }
    }

    const named = /^<(?:kith|hq) project="([a-z0-9][a-z0-9._-]*)"\/>\n?/.exec(e.prompt)
    let project = named?.[1] ?? ''
    if (!project) {
      const found = await $.process.run([`${kith}/bin/project-id`, cwd], { timeoutMs: 10_000 })
      project = found.exitCode === 0 ? found.stdout.trim() : ''
    }
    const task = named ? e.prompt.slice(named[0].length) : e.prompt
    // The project's parents, closest first (bin/project-id --info): agents read their memory too.
    const info = project ? await $.process.run([`${kith}/bin/project-id`, '--info', project], { timeoutMs: 10_000 }) : null
    const parents = info?.exitCode === 0
      ? info.stdout.trim().split('\n').slice(1).map((l) => l.split('\t')[0]).join(' ')
      : ''
    if (!state) state = (await kithPaths($, kith)).KITH_STATE
    const memoryFile = `${lifeOf(agent, kith)}/memory/MEMORY.md`
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
  }).catch(($, e, next) => next(e)) // never block a spawn because of kith

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
    const kith = await kithRoot($, (options.kith_path || options.hq_path))
    if (!state) state = (await kithPaths($, kith)).KITH_STATE
    const file = `${lifeOf(run.agent, kith)}/memory/sessions/${run.project}.md`
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

  on('command.run', { command: 'kith' }, async ($, e) => {
    const kith = await kithRoot($, (options.kith_path || options.hq_path))
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (!Object.keys(installed).length) installed = await listAgents($, kith)
    const agents = Object.keys(installed).sort()

    if (words.length === 0) {
      const project = await $.process.run([`${kith}/bin/project-id`, await $.session.cwd()])
      return {
        text:
          `kith agents: ${agents.join(', ')}\n` +
          `project here: ${project.exitCode === 0 ? project.stdout.trim() : 'none'}\n` +
          'Delegate with /kith <agent> [-p project] <task>.',
      }
    }

    const [agent, ...rest] = words
    if (!agents.includes(agent)) return { text: `kith: no agent '${agent}'. Agents: ${agents.join(', ')}` }
    let project = ''
    if (rest[0] === '-p') {
      project = rest[1] ?? ''
      rest.splice(0, 2)
    }
    const task = rest.join(' ')
    if (!task) return { text: `kith: what should ${agent} do? /kith ${agent} [-p project] <task>` }
    if (liveAgents.has(agent)) return { context: [liveAsk(kith, agent, task, project)] }
    return {
      context: [
        `The user asked to delegate this to the kith specialist \`kith:${agent}\`. Call the Agent tool with ` +
          `subagent_type "kith:${agent}" and this prompt, word for word:\n\n` +
          (project ? `<kith project="${project}"/>\n` : '') +
          task +
          '\n\nWhen it reports back, relay what it did and anything it needs from the user.',
      ],
    }
  })

  on('tool.call', { tool: 'mcp__kith__invoke' }, async ($, e) => {
    const input = e as unknown as { agent: string; task: string; project?: string }
    if (liveAgents.has(input.agent)) {
      return { result: liveAsk(await kithRoot($, (options.kith_path || options.hq_path)), input.agent, input.task, input.project ?? '') }
    }
    const prompt = (input.project ? `<kith project="${input.project}"/>\n` : '') + input.task
    const started = await $.agent.spawn({
      subagentType: `kith:${input.agent}`,
      description: `kith ${input.agent}`,
      prompt,
    })
    return {
      result: started.deny
        ? `kith: could not start ${input.agent}: ${started.deny}`
        : `kith:${input.agent} started (agent ${started.agentId}); its report arrives when it finishes.`,
    }
  }).catch(() => ({ result: 'kith: invoke failed inside the kith plugin.' }))
}
