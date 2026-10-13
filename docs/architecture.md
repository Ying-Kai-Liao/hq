# hq architecture

What hq is made of, what is built, and where it is going. Read this before changing the kernel or designing a new
agent. How a run works step by step: `how-hq-runs.html`. Commands and file formats: the README.

## The model

| Part | What it is | Lives in | Status |
|---|---|---|---|
| **Plugin** | A capability: a skill, the tools it drives, and the software they need | inside an agent's `skills/` + `tools/` today | partly: no manifest or `requires` yet |
| **Package** | A whole agent: identity (`agent.md`), settings, capabilities, its plugins | `agents/<name>/` minus state | built: versioned and snapshotted |
| **State** | What an agent and the user accumulate: memory, data, learned skills, user.md, projects | the state folder, `$HQ_STATE` or `~/.hq` (own private git repo) | built: never snapshotted |
| **Service** | Something several agents may use: an MCP server, an API, a login | `shared/services/<name>.json` | built |
| **Grant** | Which agent may use which service, as which account | `~/.config/hq/auth.json` (local, never in the repo) | built |
| **Environment** | The installed software a package's plugins need, built per machine | not yet | planned |
| **Kernel** | Runs agents and connects them: `bin/hq`, `hq-pkg`, `hq-auth`, the bridge, the adapter | `bin/`, `adapters/` | built |

Rules that follow from it:
- **A package holds no state.** Sharing or upgrading an agent never touches anyone's memory or data.
- **A package holds no credentials.** It says what it needs (`needs:`); the user decides what it gets (grants).
- **Each capability has one owning agent** and is loaded only there; the split exists to save context tokens. Other
  agents call the owner as a helper instead of copying the capability.
- **Agents refer to the kernel through placeholders** (`{{AGENT_DIR}}`, `{{HOME_DIR}}`, `{{HQ}}`) and env vars
  (`HQ_AGENT_HOME`), never hard-coded paths, so kernel changes don't require editing every agent.

## Built

**State folder** (2026-10-14). Memory, data, learned skills, `user.md`, projects and `projects.json` live in
`$HQ_STATE` (default `~/.hq`), a git repo of its own with the same relative paths as the repo had. Databases are
committed as text dumps (`hq-state dump`). Without a state folder everything falls back to the repo, which is how
`bin/hq-migrate-state` moved it without downtime. Learned skills are state; `hq-pkg promote` moves a proven one
into the package. Personal details moved out of the packages too (2026-10-14); `hq-pkg check --share` guards it.
Third-party skills are linked from their repos (skills.json), never copied. Published 2026-10-14 with fresh history (MIT).

**Versions** (`bin/hq-pkg`). Agents change all the time: an agent learns a skill, the user asks it to change, or a
code agent edits it. None of that waits for running sessions. Every run is pinned to a read-only snapshot,
`.store/<name>@<version>/`; a changed package is checked first, and a failing version never runs (the last good
one does). `.editing` holds back a change that spans several files. `hq versions | pin | rollback | unpin`.

**Services and auth** (`bin/hq-auth`). Service definitions live in the repo, needs in the package, grants on the
user's machine. MCP services start only when needed and granted, with secrets in the server process alone; tools
ask `hq-auth get`. Every secret handed out is logged. Least privilege between cooperating agents, not a sandbox.

**Model, effort and cost.** `model:` and `effort:` in `agent.md` set what an agent runs on, in `hq` runs and as an
`hq:<name>` subagent. `bin/hq-cost` keeps a ledger of every request; `hq` tags its sessions with agent, version,
model and effort, so `hq cost agents` / `hq cost agent <name>` show what each agent and each version costs.

**Channels** (`bin/hq-bridge`, `bin/hq-send`). Discord, one bot, a channel per agent. The channel's agent owns the
task, calls other agents as helpers, and answers in the task's thread.

Known gap: an agent called as an `hq:<name>` subagent shares the calling session's MCP servers, so grants only
apply to full `hq <agent>` runs.

## Planned

**Per-agent commits.** One repo holding every agent means unrelated changes pile up together and have to be
untangled at commit time. Plan: when a new version passes its checks, `hq-pkg` commits only `agents/<name>/`, so
each agent's history is small and its own.

**Environments.** Skills increasingly need installed software (image: uv, rembg models, mermaid-cli, Chrome,
codex; video: Node kits; transcription: whisper models). Plan:
- A plugin declares `requires`, each with a `check` and an `install` command.
- `hq-pkg setup <agent>` installs what's missing into the agent's environment and does nothing if it's all there.
- A version whose requirements fail their check doesn't run, like any other failed check.
- Tools find their software through the environment (`HQ_ENV_DIR`, `PATH`), never global installs, so upgrading
  one agent's software can't break another.
- Containers are ruled out for the media agents: they need Metal, real Chrome, Keychain and the codex login.
- First case: the image agent.

**Disk.** The repo is small; the software and models agents use are not (about 32 GB on 2026-10-13: Hugging Face
models 12 GB, uv cache 12 GB, npm 4.6 GB, headless browsers 1.8 GB, design output 1.8 GB). Environments go on the
external SSD, and `bin/hq` points the tools' cache variables there (`HF_HOME`, `UV_CACHE_DIR`, `npm_config_cache`,
`U2NET_HOME`, `PUPPETEER_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`). Keep uv's cache and environments on the same
volume (it links files instead of copying). `bin/hq` should fail clearly when the SSD isn't mounted. Open: whether
this applies to hq runs only or to everything on the machine.

## Later

- **Installable packages:** a `package.yaml` with a version and plugin dependencies; install and update agents
  separately; local customizations as an overlay so updates still apply.
- **Scheduler:** launchd running agents' jobs, with tools allowed per job.
- **At scale:** one router entry instead of a description per agent; learned skills promoted only after they're
  used.
