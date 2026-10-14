# hq architecture

What hq is made of, what is built, and where it is going. Read this before changing the kernel or designing a new
agent. How a run works step by step: `how-hq-runs.html`. Commands and file formats: the README.

## Concepts (agreed 2026-10-14; the folder layout does not follow them yet)

hq has two levels, and each has the same two halves: what it **is** (shareable, versioned, the same for anyone who
installs it) and what it **has lived** (private, accumulated, yours).

| | **Is** | **Has lived** |
|---|---|---|
| **hq**, the system | the kernel: tools, PROTOCOL, service definitions | hq's knowledge: who it works for (`user.md`), projects (registry, shared maps and decisions), the team (`agents.json`), its rules (`private-words`, jobs, grants) |
| **an agent** | its role: instructions, skills, tools (the package repo) | its memory (what it knows), data (what it tracks), files (what it made) |

- "Agent" means the role plus its life, on one machine; "role" (today: package) is the part anyone can install.
- An agent's three kinds of life differ by lifecycle: **memory** is small text, versioned; **data** is databases,
  versioned as text dumps; **files** are things it made (renders, exports, images), large, not in git.
- hq's lived knowledge is not "about the user": it is what the whole system knows and runs on, shared by every agent.

Today's folders mix the halves: the kernel's `shared/` holds hq's definition while the state folder's `shared/` holds
hq's lived knowledge, and an agent's role (`agents/<name>/`) is in a different tree from its life
(`state/agents/<name>/`: `memory/`, `data/`, and since 2026-10-14 `files/`, ignored by git). The layout should mirror the table, roughly:

```
hq/                      the system
  (kernel)                  what hq is                                   public repo
  (hq's knowledge)          what hq has lived                            private repo
  agents/<name>/
    role/                   what the agent is                            its own repo
    memory/ data/ files/    what the agent has lived                     private repo (files/ ignored)
```

Open: the names (role or package; what to call hq's knowledge, given the kernel's `shared/`), whether projects are a
level of their own, and one migration to get there.

## The model

| Part | What it is | Lives in | Status |
|---|---|---|---|
| **Plugin** | A capability: a skill, the tools it drives, and the software they need | inside an agent's `skills/` + `tools/` today | partly: no manifest or `requires` yet |
| **Package** | A whole agent: identity (`agent.md`), settings, capabilities, its plugins, the skills it learned | its own git repo, checked out in the agents folder (`$HQ_AGENTS`, default `agents/<name>/` in the hq folder) | built: versioned, snapshotted, committed |
| **State** | What an agent and the user accumulate: memory, data, user.md, projects | the state folder, `$HQ_STATE` or `state/` in the hq folder (own private git repo) | built: never snapshotted |
| **Service** | Something several agents may use: an MCP server, an API, a login | `shared/services/<name>.json` | built |
| **Grant** | Which agent may use which service, as which account | `~/.config/hq/auth.json` (local, never in the repo) | built |
| **Environment** | The installed software a package's plugins need, built per machine | not yet | planned |
| **Kernel** | Runs agents and connects them: `bin/hq`, `hq-pkg`, `hq-auth`, the bridge, the adapter | this repo: `bin/`, `adapters/`, `shared/`; no agents | built |

Rules that follow from it:
- **A package holds no state.** Sharing or upgrading an agent never touches anyone's memory or data.
- **A package holds no credentials.** It says what it needs (`needs:`); the user decides what it gets (grants).
- **Each capability has one owning agent** and is loaded only there; the split exists to save context tokens. Other
  agents call the owner as a helper instead of copying the capability.
- **An agent is a repo.** Installed from a GitHub link, changed by anyone, every good version committed; restore,
  share or keep private per agent. The kernel finds agents only through `hq-pkg` (`installed()`, `hq-pkg list`).
- **Agents refer to the kernel through placeholders** (`{{AGENT_DIR}}`, `{{PACKAGE}}`, `{{AGENTS}}`, `{{HOME_DIR}}`, `{{HQ}}`) and env vars
  (`HQ_AGENT_HOME`), never hard-coded paths, so kernel changes don't require editing every agent.

## Built

**State folder** (2026-10-14). Memory, data, `user.md`, projects and `projects.json` live in
`$HQ_STATE` (default `<hq>/state`), a git repo of its own. Databases are committed as text dumps (`hq-state dump`).
Personal details moved out of the packages too (2026-10-14);
`hq-pkg check --share` guards it. Third-party skills are linked from their repos (skills.json), never copied.
Published 2026-10-14 with fresh history (MIT).

**One folder** (2026-10-14). Agents and state moved into the hq folder, `agents/` and `state/`, each still its own
repo and ignored by the kernel: one place to manage, the same repo boundaries. `~/.hq` stays as a link to `state/`
and `state/packages` as one to `../agents`, for paths that still name them (launchd jobs, agents' own tools).

**Agents as repos** (2026-10-14). The kernel repo ships no agents. Each agent is a git repo in the agents folder
(`agents/` in the hq folder, ignored by the kernel; `<state>/agents.json` records each one's link so `install.sh` brings
them back on another Mac). `hq install <link>` clones one (a repo, or a folder of one via `/tree/<ref>/<path>`);
`hq-pkg resolve` commits every version that passes its checks, so the agent's git log is its version history and
`hq restore <agent> <commit>` brings any of them back as a new commit. Learned skills are part of the package
(`{{PACKAGE}}/skills/learned/`): they version, restore and share with the agent; a skill the user won't share stays
in the state folder. `hq share` creates `<you>/hq-agent-<name>` (private); `--public` refuses while the package or
any old commit carries personal details. The author's agents were split out of this repo's old history with it.

**Versions** (`bin/hq-pkg`). Agents change all the time: an agent learns a skill, the user asks it to change, or a
code agent edits it. None of that waits for running sessions. Every run is pinned to a read-only snapshot,
`<agents folder>/.store/<name>@<version>/` (same disk as the agents, so APFS clones); a changed package is checked first, and a failing version never runs (the last good
one does), and the version is committed to the agent's repo. `.editing` holds back a change that spans several
files. `hq versions | pin | rollback | unpin` for snapshots on disk; `hq history | restore` for every version ever.

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

**Publishing an agent with a past.** `hq share --public` refuses an agent whose old commits name the user. Next:
`--fresh`, a public repo from the current version alone, kept in step from the private one.

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

- **Installable packages:** agents install, update and share separately now (repos). Still to come: plugin
  dependencies, and local customizations as an overlay so upstream updates still apply after you've edited one
  (today `hq update` only fast-forwards; diverged edits are merged by hand).
- **Scheduler:** launchd running agents' jobs, with tools allowed per job.
- **At scale:** one router entry instead of a description per agent; learned skills promoted only after they're
  used.
