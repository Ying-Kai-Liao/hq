# Codebase map

Where every part of hq lives, what each file does, and which file to open for a given change. The model and the
reasons behind it are in [architecture.md](architecture.md); commands are in the [README](../README.md).

## Where things are on disk

```
~/hq -> hq/                       the hq folder (HQ_HOME), wherever it really is (an external disk)
hq/                               this repo (public): README, docs/, install.sh, .claude-plugin/
  docs/                             architecture.md (the model), this map, how-hq-runs.html (+ .architecture.json,
                                    its source) and img/how-hq-runs-{light,dark}.png (the README's picture)
hq/kernel/                        the code: what hq is (bin/, lib/, adapters/, PROTOCOL.md, services/)
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
~/.hq/                            this Mac's hq, a real folder on the internal disk (like ~/.claude)
  user.md                           committed (the hq-state repo, $HQ_STATE): who hq works for, read by every agent
  projects/<id>/                    committed: codebase.md, verify.md, decisions.md, per-project notes shared by agents
  projects.json                     committed: project registry (bin/project-id): aliases, parent, home
  agents.json                       committed: installed agents and where their roles come from (hq-pkg save)
  private-words                     committed: words hq-pkg check --share refuses in a role
  .gitignore                        ignores everything else (kernel/lib/dot-hq.gitignore): from here down, this Mac only
  secrets/                          auth.json (grants and profiles, hq-auth), auth.log, env (bridge, Telegram, tokens);
                                    agents' file tools are denied it (bin/hq)
  settings.json                     hq's own settings for this Mac, not secret (lib/hq_settings.py): permission_mode, agents
  ask.json  remotes.json            hq ask conversations → sessions; other machines (hq-remote)
  cost.db                           the cost ledger (hq-cost)
  bridge/  sched/                   Discord thread → session map, attachments; last tick and runs per job
  monitor/  house/  cost/           devops' monitor.db and monitor.log; house's remind.log; the cost sync.log
  store/<name>@<version>/           read-only role snapshots runs are pinned to (prompt.md, settings.json, .home);
  store/.pointers/                  unchanged files hard-linked to the previous version's; good/pin per agent
  logs/                             bridge.log, sched/tick.log, sched/runs/<agent>/ (each scheduled run's output)
  cache/                            rebuildable: handoff/ (scratch clones and worktrees of callers' repos, hq-remote)
  bin/hq-uv                         uv copy with Full Disk Access, what every launchd job runs (repo on an external disk)
~/Workspace/hq -> hq/kernel/      older address of the kernel, kept for paths that still name it (removable)
```

Every tool asks one resolver, `lib/hq_paths.py` (bash: `eval "$(python3 lib/hq_paths.py --sh)"`; the plugin runs
it with `--json`). `HQ_HOME` is the variable, else `~/hq`, else the kernel's folder; agents are `<home>/agents`.
`~/.hq` gives the rest: `HQ_STATE` (itself), `HQ_MACHINE`, `HQ_SECRETS`, `HQ_STORE`, `HQ_LOGS`, `HQ_CACHE`. While
`~/.hq` is still a link to the hq folder (the layout before 2026-10-15) it answers the old places instead:
`<home>/state`, `~/.config/hq`, `<agents>/.store`, `~/Library/Logs/hq`, `~/Library/Caches/hq`.
It gives each folder path twice: the address (no symlinks resolved, so no volume name with spaces reaches prompts
or Bash rules) and `_REAL` (resolved; what Claude Code matches file permission rules against). They are outputs,
exported for agents' tools, not settings. An agent's role is `<agents>/<name>/role` and its life the folder around
it; an agent without `role/` is the older layout (the folder is the role, the life is `<state>/agents/<name>`).
Agents' settings and tools name these through placeholders and env vars, never `~/.config/hq`.

## Background jobs

LaunchAgents in `~/Library/LaunchAgents/`, each run through `~/.hq/bin/hq-uv`, by the `~/hq` address (not the disk path).

| Label | Runs | When | Written by |
|---|---|---|---|
| `dev.hq.bridge` | `kernel/bin/hq-bridge` | always (KeepAlive) | `hq-bridge --install` |
| `dev.hq.sched` | `kernel/bin/hq-sched tick` | every minute | `hq-sched --install` (not installed on this Mac) |
| `dev.hq.cost` | `kernel/bin/hq-cost sync` | every 6 h | by hand (no installer) |
| `dev.hq.monitor` | devops `role/tools/monitor.py run` | always (KeepAlive) | `monitor.py install` (devops' repo) |
| `dev.hq.house` | house `role/tools/house.py remind --send` | 08:00 daily | by hand (no installer) |

## Kernel files

Paths in this table are inside `kernel/`, except `install.sh` and `.claude-plugin/marketplace.json` (top of the repo).

| File | Lang | What it does | Called by |
|---|---|---|---|
| `bin/hq` | bash | Runs one agent: resolves the pinned package, fills placeholders, adds memory and project, settings + cost-tag hook, granted MCP servers, model/effort, then `exec claude`. Also the front door for `versions`, `install`, `auth`, `cost`… | you, `hq-bridge`, agents calling helpers |
| `bin/hq-pkg` | python | Packages: fingerprint → check → snapshot into `~/.hq/store` (clones or hard links), gc; pin/rollback; auto-commit each good version to the agent's repo; install/update/share/search/restore; fetch third-party skills; `check --share` privacy scan | `bin/hq`, the adapter (`resolve --all --json`), `install.sh` |
| `bin/hq-auth` | python | Services and grants: which agent may use which service as which account; builds `--mcp-config`; hands out secrets (`get`, `exec`) and logs them | `bin/hq`, agents' tools |
| `bin/hq-cost` | python | Cost ledger: syncs request usage from `~/.claude/projects` into `cost.db`; `tag` records each hq session (SessionStart hook); reports by agent, version, model, effort | you, launchd `dev.hq.cost`, the hook `bin/hq` adds |
| `bin/hq-ask` | python | One-shot `hq <agent>` with `--output-format json`: prints the answer, keeps agent + directory (or `--as NAME`) → session in `~/.hq/ask.json` so `-c` resumes it with the same project/model/effort; `HQ_VIA=ask` | you, scripts, Claude Code sessions |
| `bin/hq-remote` | python | Other machines over ssh: `add`/`ls`/`rm` (`~/.hq/remotes.json`); `ask AGENT@MACHINE` (from hq-ask): snapshot the working tree as a commit, push it to a scratch clone there, run `hq ask` there in a worktree, fetch the result branch and copy `.hq-out` back. Its agent side is `_repo` and `_run` | hq-ask, over ssh on the other machine |
| `bin/hq-memory` | python | Memory search: indexes the agents' memory and private skills and the state folder's user.md and projects/ in an in-memory FTS5 table per search, prints `path:line` + passage | you, agents (PROTOCOL.md; allowed without a prompt in `hq` runs) |
| `bin/hq-sched` | python | Scheduled jobs: cron parser, `jobs.json` per agent, `tick` starts due jobs as detached `hq <agent> "task"` runs (`HQ_VIA=schedule`), catches up once after sleep; launchd `dev.hq.sched` | you, launchd every minute |
| `bin/hq-state` | python | Commits what was lived: sqlite → text dumps, commit and push the state repo and the agents repo, then every role | you |
| `bin/hq-new` | bash | Scaffolds `agents/<name>/`: `role/` as its own repo, memory folders next to it | you, the builder agent |
| `bin/project-id` | python | Directory → project ID from `projects.json` (remotes and paths as aliases, a path also matching the folders inside it); `--info` the project's parents and homes; `--register` with `--in PARENT`, `--home [DIR]` (bare: a new folder inside the parent's home, else under the root); `--children ID [--all]` the projects it holds and where each is on this Mac (a repo is registered by remote and checkout); `--root [DIR]` where new homes go (`homes` in `projects.json`, default `~/Documents`, asked by `hq init`) | `bin/hq`, the adapter, agents |
| `bin/hq-project` | python | `hq project`: the project here and its parents (repos, home, memory, children), `ls` as a tree, `add` (→ `project-id --register`), `root` (→ `project-id --root`), `open [ID]`: Claude Code in the project's home with `--add-dir` for everything it holds | you |
| `bin/hq-bridge` | python (uv script) | Chat: every granted bot (Discord, Telegram, Slack) in one process, each connection restarting on its own (also when it goes quiet); a watchdog thread exits the process when the loop or its thread pool is stuck (`HQ_BRIDGE_STALL`, default 180 s) so launchd starts it again; launchd `dev.hq.bridge` | launchd |
| `lib/hq_bridge/core.py` | python | The bridge's core: people (`hq-auth who`), access, rooms and defaults, `@agent` routing, threads → `{agent: session}`, the queue with the Jev router, stop, runs `hq <agent>` with `HQ_PERSON`, posts what the run's outbox holds | `hq-bridge` |
| `lib/hq_bridge/discord_chat.py`, `telegram_chat.py`, `slack_chat.py` | python | One adapter per platform: receive, post as the agent, threads, the working line with Stop, buttons, files; Telegram's Markdown → HTML. What came while the bridge was away is answered once, marked late: Telegram from its saved offset, Discord from history after the last message it saw (24 h at most) | `hq-bridge` |
| `tests/hq-bridge-check` | python (uv script) | The bridge's self-healing against fake Discord and Telegram and a stub `hq`, in a throwaway HOME: one answer per message, catch-up after downtime, dead connections replaced, a stuck loop exits | you, after a bridge change |
| `bin/hq-acp` | python | `hq acp <agent> [--keep …]`: the agent as an ACP agent for clients like Codync. Runs claude-agent-acp with `adapters/acp/claude-via-hq` as its claude; drops the client's MCP servers (except `--keep`) and `_meta.systemPrompt`; gives each group chat its own agent session (map in `~/.hq/acp/<agent>.json`), rewriting session ids both ways so the client only sees its own; logs in `~/.hq/logs/acp/` | an ACP client (a Codync bot's `command`) |
| `bin/hq-send` | bash | Delivers a result: into the Discord thread when inside one, into the bridge's outbox (`HQ_BRIDGE_OUTBOX`) inside any other chat task, else Telegram | agents |
| `bin/hq-init` | python | Setup, safe to repeat: checks git (+ identity), claude, gh, uv; makes ~/.hq and the agents folder git repos with a first commit and `user.md`; offers private GitHub backups; installs what agents.json lists; offers a starter (`lib/starters.json`). `--from <user>` clones that user's hq-state and hq-agents first (a new Mac) | `install.sh` (last step), you |
| `bin/hq-doctor` | python | Read-only checks with a fix for each: folders and links, tools, the state, agents and role repos (uncommitted, unpushed, no backup), agent checks, grants, plugin version, each `dev.hq.*` job (loaded, running, stuck in hq-uv = lost Full Disk Access) | you |
| `lib/dot-hq.gitignore`, `lib/agents.gitignore`, `lib/user.md`, `lib/starters.json` | text | What `hq init` puts in a new ~/.hq and agents folder; the starter agents it offers (link null until published) | `hq-init` |
| `lib/hq_paths.py` | python | The resolver: HQ_HOME, state, agents (address and `_REAL`), machine, logs, caches; `--sh` / `--json` | every tool, the adapter |
| `lib/hq_settings.py` | python | hq's own settings (hq-wide, not secret): this Mac's `~/.hq/settings.json` over the defaults; today `permission_mode` (default `auto`), the mode a run starts in when neither the caller nor the agent sets one, and `agents.<name>.permission_mode`, this Mac's choice over an agent's own (suggested) mode | `bin/hq`, `hq-doctor`, `hq-pkg` (install asks) |
| `adapters/claude-code/hooks/hooks.json` | JSON | Loads `register.tsx` as the plugin's hooks module | Claude Code |
| `adapters/claude-code/hooks/register.tsx` | TS | The Claude Code plugin: registers each agent as `hq:<name>` (pinned package, frontmatter `model`), puts project + memory in front of each spawn, applies `effort` per request, nudges for the session file, `/hq` and `mcp__hq__invoke` | Claude Code, every session |
| `adapters/acp/claude-via-hq`, `adapters/acp/shim/claude` | bash, python | The SDK's claude binary: saves the SDK's args and runs `hq <agent>` with the shim first on PATH; the shim merges hq's args with the SDK's (one appended system prompt, hq's first; the client's permission mode wins). Codync's memory keeper runs on plain claude | `bin/hq-acp` (via claude-agent-acp) |
| `adapters/claude-code/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | JSON | Plugin manifest (option `hq_path`) and this repo as its marketplace | `install.sh` |
| `kernel/PROTOCOL.md` | md | The rules every agent gets after its `agent.md`: memory, projects, sessions, learned skills, delivery | `hq-pkg` (into `prompt.md`), the adapter |
| `kernel/services/<name>.json` | JSON | One shared service: kind (mcp, cli, login), how to start it, secret names (never values) | `hq-auth`, `hq-pkg` checks |
| `install.sh` (top) | bash | Links `~/hq` and `~/.local/bin/hq`, makes `~/.hq/secrets`, installs the plugin, then runs `hq init` with its arguments (`--from <user>`) | you, once per Mac |

## Placeholders and environment

Packages never hold absolute paths. `bin/hq` and the adapter fill these in at run time; `hq-pkg` rejects unknown ones.

| Placeholder | Becomes | Env var for tools |
|---|---|---|
| `{{HQ}}` | the kernel repo | `HQ_ROOT` |
| `{{AGENT}}` | the agent's name | `HQ_AGENT` |
| `{{AGENT_DIR}}` | the pinned snapshot this run uses | `HQ_AGENT_DIR` |
| `{{PACKAGE}}` | the agent's live `role/` (where learned skills are written) | |
| `{{HOME_DIR}}` / `{{HOME_REAL}}` | the agent's own folder `<agents>/<name>` (memory, data, files); the same with symlinks resolved, for permission rules | `HQ_AGENT_HOME` |
| `{{MEMORY_DIR}}` / `{{FILES_DIR}}` / `{{PERSON_FILE}}` | whose memory, outputs and profile the run uses: the owner's `memory/`, `files/`, `user.md`; anyone else's `memory/people/<id>/`, `files/people/<id>/`, `<state>/people/<id>.md` | |
| `{{SHARED_MEMORY}}` | `memory/shared/`: the craft, for everyone who uses the agent | |
| `{{STATE}}` / `{{AGENTS}}` | the state folder; the agents folder | `HQ_STATE`, `HQ_AGENTS` (also `HQ_HOME`) |
| `{{MACHINE}}` | this Mac's hq folder, `~/.hq` (`bridge/attachments/`, …; never `secrets/`, which runs are denied) | `HQ_MACHINE` |
| `{{USER_HOME}}` | `$HOME` | |

Also set for a run: `HQ_AGENT_VERSION`, `HQ_MODEL`, `HQ_EFFORT`, `HQ_PROJECT` (read by `hq-cost tag`), and, from the
bridge, `HQ_VIA=discord`, `telegram` or `slack`, `HQ_BRIDGE_OUTBOX`, `HQ_PERSON` for anyone but the owner (`schedule` from hq-sched, plus `HQ_SCHED_JOB`; `ask` from hq-ask), `HQ_DISCORD_WEBHOOK_URL`, `HQ_DISCORD_THREAD_ID` (read by `hq-send`), `HQ_CLAUDE_ARGS`
(extra `claude` flags; `bin/hq` clears it once read so helpers don't inherit it).

## Flows

**`hq <agent> "task"`** (terminal, or the bridge on a Discord message)
1. `bin/hq` → `hq-pkg resolve <agent>`: unchanged package → its current snapshot; changed → check, snapshot into
   `~/.hq/store`, commit to the agent's repo; failing check → the last good version.
2. Prompt = snapshot `prompt.md` (agent.md body + PROTOCOL.md) with placeholders filled + `MEMORY.md` + session tag.
3. Settings = snapshot `settings.json` + a SessionStart hook → `hq-cost tag`. MCP = `hq-auth mcp-config <agent>` +
   the package's `mcp.json`. `--model`/`--effort` from frontmatter.
4. `exec claude`. The agent reads skills from `{{AGENT_DIR}}`, writes memory to `{{HOME_DIR}}`, delivers with `hq-send`.

**`hq:<name>` inside any Claude Code session** (`register.tsx`)
1. Session start: `hq-pkg resolve --all --json` pins every agent for the session; each is registered with its prompt
   and model; efforts are noted.
2. Spawn: project from `<hq project>` or `project-id`, its parents (`project-id --info`), plus fresh `MEMORY.md`, go in front of the task. Every session in a project with a parent, home or children gets one `hq project:` line in its system prompt (`prompt.compose`).
3. Each request: the agent's effort. Stop: one nudge if the session file wasn't written.
   Runs on the caller's settings and MCP servers, not the agent's (known gap).

**An agent changes** (you edit it, ask it to, or it writes a learned skill into `{{PACKAGE}}`)
→ the next run's fingerprint differs → `hq-pkg` checks it → snapshot + commit to `agents/<name>` →
`hq push <name>` or `hq-state commit` pushes it. Running sessions keep their snapshot.

**What was lived changes** (memory, data) → written straight to `agents/<name>/` → `hq-state commit` dumps the
databases and commits and pushes the agents repo and the state repo.

**`hq ask house@mini` from another machine** → hq-ask hands it to hq-remote → in a git repo: working tree → commit
(temp index) → `git push` over ssh to `~/.hq/cache/handoff/<repo>/repo` on mini → ssh `hq remote _run`: worktree on
`hq/house/<id>`, `hq ask house` there (mode from its `HQ_REMOTE_PERMISSION_MODE`, else the agent's, else hq's default;
`CLAUDE_CODE_OAUTH_TOKEN` from its env file), leftovers committed →
JSON answer back → `git fetch` the branch, `scp` `.hq-out/` to `./hq-out/<id>/`.

**A scheduled job** → launchd runs `hq-sched tick` every minute → for each `jobs.json` job whose cron time fell since
the last tick (at most a day back) and that isn't still running: `hq <agent> "task + scheduled note"` detached, with
`--permission-mode` from `HQ_SCHED_PERMISSION_MODE` when set (else the agent's mode, else hq's default) → output in
`~/.hq/logs/sched/runs/<agent>/`, delivery by `hq-send`.

**Cost** → Claude Code writes transcripts → `hq-cost sync` (every 6 h, and before each report) → `cost.db`;
`runs` (from the hook) and `hq:` subagent types attribute requests to agents.

## Where to change what

| To change | Open |
|---|---|
| What every agent is told (memory, sessions, delivery rules) | `kernel/PROTOCOL.md` |
| How a run is assembled (flags, prompt, settings, model/effort) | `bin/hq`, and the same in `register.tsx` for subagents |
| What makes a version valid, snapshots, auto-commit, install/share | `bin/hq-pkg` (`problems()` for checks) |
| A new placeholder | `bin/hq` `fill()`, `register.tsx` `fill`, `hq-pkg` `PLACEHOLDERS` |
| Services, grants, secrets | `kernel/services/`, `kernel/bin/hq-auth` |
| Discord behaviour | `bin/hq-bridge`; delivery in `bin/hq-send` |
| How memory is searched (what's indexed, ranking) | `bin/hq-memory` |
| Scheduled jobs (cron syntax, catch-up, how a job runs) | `bin/hq-sched` |
| Where hq's folders are (HQ_HOME, ~/.hq and what is in it) | `lib/hq_paths.py`, nowhere else |
| An hq-wide setting that isn't secret (the default permission mode) | `lib/hq_settings.py` `DEFAULTS`; per Mac, `~/.hq/settings.json` |
| A background job | its row in [Background jobs](#background-jobs): the installer, or the plist itself where there is none |
| Calling agents on other machines, the code handoff | `bin/hq-remote` (`call` on the caller, `serve_run` on the agent's machine) |
| Cost reports or prices | `bin/hq-cost` (`PRICES`) |
| The scaffold for new agents | `bin/hq-new`, and the builder agent's `new-agent` skill (in its own repo) |
| One agent's behaviour, skills or tools | that agent's repo, `agents/<name>/` (its own repo; the kernel ignores it) |
