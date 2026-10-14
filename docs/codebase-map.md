# Codebase map

Where every part of hq lives, what each file does, and which file to open for a given change. The model and the
reasons behind it are in [architecture.md](architecture.md); commands are in the [README](../README.md).

## Where things are on disk

```
hq/                               the kernel (this repo, public): what hq is. agents/ and state/ sit inside it, ignored
hq/state/                         what hq has lived, $HQ_STATE: your private repo (<you>/hq-state); ~/.hq links here
  shared/user.md                    who hq works for, read by every agent
  shared/projects/<id>/             codebase.md, decisions.md: per-project notes shared by agents
  projects.json                     project registry (bin/project-id)
  agents.json                       installed agents and where their roles come from (hq-pkg save / install --saved)
  private-words                     words hq-pkg check --share refuses in a role
  agents -> ../agents               link for paths from before 2026-10-14 (ignored)
hq/agents/                        the agents folder, $HQ_AGENTS: your private repo (<you>/hq-agents), each agent's life
  <name>/                           one agent
    role/                             what it is: its own git repo (<you>/hq-agent-<name>), ignored by hq-agents
      agent.md                          frontmatter (description, model, effort) + instructions
      capabilities.yaml                 tools, needs: [services], global_skills
      settings.json                     Claude Code settings merged over yours for its runs
      skills/  skills.json  tools/      own skills; third-party skills by link; its CLIs
    memory/                           MEMORY.md, projects/<id>.md, sessions/<project>.md
    data/                             its databases (*.db ignored; committed as *.sql text dumps)
    files/<project>/                  what it made: renders, images, exports, backups (ignored: on disk only)
    skills/learned/                   skills kept private (hq-pkg promote moves one into role/)
    jobs.json                         its scheduled jobs (hq-sched)
  .store/<name>@<version>/          read-only snapshots of roles runs are pinned to (prompt.md, settings.json, .home)
~/.config/hq/                     this machine only, never in git
  auth.json  auth.log               grants and profiles (hq-auth); every secret handed out
  env                               bridge and Telegram settings
  cost.db                           the cost ledger (hq-cost)
  remotes.json  handoff/            other machines (hq-remote); scratch clones and worktrees of callers' repos
  ask.json                          hq ask conversations: agent + directory or name → session
  sched/                            last tick, last run per job, each run's output (hq-sched)
  bridge/                           Discord thread → session map, logs, attachments
  monitor/  house/  bin/hq-uv       the monitor's samples; house's job state; uv copy with Full Disk Access
```

Every tool finds the folders the same way: `$HQ_STATE`, else `<hq>/state`, else `~/.hq` (installs from before
2026-10-14). Agents: `$HQ_AGENTS`, else `<hq>/agents`, else `<state>/packages`. An agent's role is `<agents>/<name>/role`
and its life the folder around it; an agent without `role/` is the older layout (the folder is the role, the life
is `<state>/agents/<name>`).

## Kernel files

| File | Lang | What it does | Called by |
|---|---|---|---|
| `bin/hq` | bash | Runs one agent: resolves the pinned package, fills placeholders, adds memory and project, settings + cost-tag hook, granted MCP servers, model/effort, then `exec claude`. Also the front door for `versions`, `install`, `auth`, `cost`… | you, `hq-bridge`, agents calling helpers |
| `bin/hq-pkg` | python | Packages: fingerprint → check → snapshot into `.store`; pin/rollback; auto-commit each good version to the agent's repo; install/update/share/search/restore; fetch third-party skills; `check --share` privacy scan | `bin/hq`, the adapter (`resolve --all --json`), `install.sh` |
| `bin/hq-auth` | python | Services and grants: which agent may use which service as which account; builds `--mcp-config`; hands out secrets (`get`, `exec`) and logs them | `bin/hq`, agents' tools |
| `bin/hq-cost` | python | Cost ledger: syncs request usage from `~/.claude/projects` into `cost.db`; `tag` records each hq session (SessionStart hook); reports by agent, version, model, effort | you, launchd `dev.hq.cost`, the hook `bin/hq` adds |
| `bin/hq-ask` | python | One-shot `hq <agent>` with `--output-format json`: prints the answer, keeps agent + directory (or `--as NAME`) → session in `~/.config/hq/ask.json` so `-c` resumes it with the same project/model/effort; `HQ_VIA=ask` | you, scripts, Claude Code sessions |
| `bin/hq-remote` | python | Other machines over ssh: `add`/`ls`/`rm` (`~/.config/hq/remotes.json`); `ask AGENT@MACHINE` (from hq-ask): snapshot the working tree as a commit, push it to a scratch clone there, run `hq ask` there in a worktree, fetch the result branch and copy `.hq-out` back. Its agent side is `_repo` and `_run` | hq-ask, over ssh on the other machine |
| `bin/hq-memory` | python | Memory search: indexes the agents' memory and private skills and the state folder's shared/ in an in-memory FTS5 table per search, prints `path:line` + passage | you, agents (PROTOCOL.md; allowed without a prompt in `hq` runs) |
| `bin/hq-sched` | python | Scheduled jobs: cron parser, `jobs.json` per agent, `tick` starts due jobs as detached `hq <agent> "task"` runs (`HQ_VIA=schedule`), catches up once after sleep; launchd `dev.hq.sched` | you, launchd every minute |
| `bin/hq-state` | python | Commits what was lived: sqlite → text dumps, commit and push the state repo and the agents repo, then every role | you |
| `bin/hq-new` | bash | Scaffolds `agents/<name>/`: `role/` as its own repo, memory folders next to it | you, the instructor agent |
| `bin/project-id` | python | Directory → project ID from `projects.json` (remotes and paths as aliases); `--register` | `bin/hq`, the adapter, agents |
| `bin/hq-bridge` | python (uv script) | Discord: a channel per agent, a thread per task; runs `hq <agent>` and resumes the thread's session; launchd `dev.hq.bridge` | launchd |
| `bin/hq-send` | bash | Delivers a result: into the Discord thread when inside one, else Telegram | agents |
| `adapters/claude-code/hooks/register.tsx` | TS | The Claude Code plugin: registers each agent as `hq:<name>` (pinned package, frontmatter `model`), puts project + memory in front of each spawn, applies `effort` per request, nudges for the session file, `/hq` and `mcp__hq__invoke` | Claude Code, every session |
| `adapters/claude-code/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | JSON | Plugin manifest (options `hq_path`, `state_path`) and this repo as its marketplace | `install.sh` |
| `shared/PROTOCOL.md` | md | The rules every agent gets after its `agent.md`: memory, projects, sessions, learned skills, delivery | `hq-pkg` (into `prompt.md`), the adapter |
| `shared/services/<name>.json` | JSON | One shared service: kind (mcp, cli, login), how to start it, secret names (never values) | `hq-auth`, `hq-pkg` checks |
| `install.sh` | bash | Links `hq`, reinstalls the agents `agents.json` lists, fetches skills, installs the plugin | you, once per Mac |

## Placeholders and environment

Packages never hold absolute paths. `bin/hq` and the adapter fill these in at run time; `hq-pkg` rejects unknown ones.

| Placeholder | Becomes | Env var for tools |
|---|---|---|
| `{{HQ}}` | the kernel repo | `HQ_ROOT` |
| `{{AGENT}}` | the agent's name | `HQ_AGENT` |
| `{{AGENT_DIR}}` | the pinned snapshot this run uses | `HQ_AGENT_DIR` |
| `{{PACKAGE}}` | the agent's live `role/` (where learned skills are written) | |
| `{{HOME_DIR}}` / `{{HOME_REAL}}` | the agent's own folder `<agents>/<name>` (memory, data, files); the same with symlinks resolved, for permission rules | `HQ_AGENT_HOME` |
| `{{STATE}}` / `{{AGENTS}}` | the state folder; the agents folder | `HQ_STATE`, `HQ_AGENTS` |
| `{{USER_HOME}}` | `$HOME` | |

Also set for a run: `HQ_AGENT_VERSION`, `HQ_MODEL`, `HQ_EFFORT`, `HQ_PROJECT` (read by `hq-cost tag`), and, from the
bridge, `HQ_VIA=discord` (`schedule` from hq-sched, plus `HQ_SCHED_JOB`; `ask` from hq-ask), `HQ_DISCORD_WEBHOOK_URL`, `HQ_DISCORD_THREAD_ID` (read by `hq-send`), `HQ_CLAUDE_ARGS`
(extra `claude` flags; `bin/hq` clears it once read so helpers don't inherit it).

## Flows

**`hq <agent> "task"`** (terminal, or the bridge on a Discord message)
1. `bin/hq` → `hq-pkg resolve <agent>`: unchanged package → its current snapshot; changed → check, snapshot into
   `.store`, commit to the agent's repo; failing check → the last good version.
2. Prompt = snapshot `prompt.md` (agent.md body + PROTOCOL.md) with placeholders filled + `MEMORY.md` + session tag.
3. Settings = snapshot `settings.json` + a SessionStart hook → `hq-cost tag`. MCP = `hq-auth mcp-config <agent>` +
   the package's `mcp.json`. `--model`/`--effort` from frontmatter.
4. `exec claude`. The agent reads skills from `{{AGENT_DIR}}`, writes memory to `{{HOME_DIR}}`, delivers with `hq-send`.

**`hq:<name>` inside any Claude Code session** (`register.tsx`)
1. Session start: `hq-pkg resolve --all --json` pins every agent for the session; each is registered with its prompt
   and model; efforts are noted.
2. Spawn: project from `<hq project>` or `project-id`, plus fresh `MEMORY.md`, go in front of the task.
3. Each request: the agent's effort. Stop: one nudge if the session file wasn't written.
   Runs on the caller's settings and MCP servers, not the agent's (known gap).

**An agent changes** (you edit it, ask it to, or it writes a learned skill into `{{PACKAGE}}`)
→ the next run's fingerprint differs → `hq-pkg` checks it → snapshot + commit to `agents/<name>` →
`hq push <name>` or `hq-state commit` pushes it. Running sessions keep their snapshot.

**What was lived changes** (memory, data) → written straight to `agents/<name>/` → `hq-state commit` dumps the
databases and commits and pushes the agents repo and the state repo.

**`hq ask house@mini` from another machine** → hq-ask hands it to hq-remote → in a git repo: working tree → commit
(temp index) → `git push` over ssh to `~/.config/hq/handoff/<repo>/repo` on mini → ssh `hq remote _run`: worktree on
`hq/house/<id>`, `hq ask house` there (acceptEdits, `CLAUDE_CODE_OAUTH_TOKEN` from its env file), leftovers committed →
JSON answer back → `git fetch` the branch, `scp` `.hq-out/` to `./hq-out/<id>/`.

**A scheduled job** → launchd runs `hq-sched tick` every minute → for each `jobs.json` job whose cron time fell since
the last tick (at most a day back) and that isn't still running: `hq <agent> "task + scheduled note"` detached, with
`--permission-mode` from `HQ_SCHED_PERMISSION_MODE` → output in `~/.config/hq/sched/runs/<agent>/`, delivery by `hq-send`.

**Cost** → Claude Code writes transcripts → `hq-cost sync` (every 6 h, and before each report) → `cost.db`;
`runs` (from the hook) and `hq:` subagent types attribute requests to agents.

## Where to change what

| To change | Open |
|---|---|
| What every agent is told (memory, sessions, delivery rules) | `shared/PROTOCOL.md` |
| How a run is assembled (flags, prompt, settings, model/effort) | `bin/hq`, and the same in `register.tsx` for subagents |
| What makes a version valid, snapshots, auto-commit, install/share | `bin/hq-pkg` (`problems()` for checks) |
| A new placeholder | `bin/hq` `fill()`, `register.tsx` `fill`, `hq-pkg` `PLACEHOLDERS` |
| Services, grants, secrets | `shared/services/`, `bin/hq-auth` |
| Discord behaviour | `bin/hq-bridge`; delivery in `bin/hq-send` |
| How memory is searched (what's indexed, ranking) | `bin/hq-memory` |
| Scheduled jobs (cron syntax, catch-up, how a job runs) | `bin/hq-sched` |
| Calling agents on other machines, the code handoff | `bin/hq-remote` (`call` on the caller, `serve_run` on the agent's machine) |
| Cost reports or prices | `bin/hq-cost` (`PRICES`) |
| The scaffold for new agents | `bin/hq-new`, and the instructor agent's `new-agent` skill (in its own repo) |
| One agent's behaviour, skills or tools | that agent's repo, `agents/<name>/` (its own repo; the kernel ignores it) |
