# hq architecture

What hq is made of, what is built, and where it is going. Read this before changing the kernel or designing a new
agent. How a run works step by step: `how-hq-runs.html`. Commands and file formats: the README.

## Concepts (agreed and built 2026-10-14)

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

The folders mirror the table:

```
~/hq -> hq/              the hq folder, anywhere (an external disk): this repo
  kernel/                   what hq is: the code                         public (this repo)
  agents/                   the agents' lives                            private repo (hq-agents)
    <name>/role/              what the agent is                          its own repo (hq-agent-<name>)
    <name>/memory/ data/ files/   what the agent has lived              (files/ not in git)
~/.hq/                   this Mac's hq, on the internal disk (like ~/.claude)
  user.md projects/ projects.json agents.json private-words
                            what hq has lived                            private repo (hq-state)
  secrets/ bridge/ sched/ cost.db store/ logs/ cache/ …
                            this machine only                            never in git
```

Open: whether projects are a level of their own.

## The model

| Part | What it is | Lives in | Status |
|---|---|---|---|
| **Plugin** | A capability: a skill, the tools it drives, and the software they need | inside an agent's `skills/` + `tools/` today | partly: no manifest or `requires` yet |
| **Role** (package) | What an agent is: identity (`agent.md`), settings, capabilities, its plugins, the skills it learned | its own git repo, `agents/<name>/role/` | built: versioned, snapshotted, committed |
| **Life** | What an agent has lived: memory, data, files, jobs | next to its role, `agents/<name>/` (the private hq-agents repo; files/ not in git) | built: never snapshotted |
| **State** | What hq has lived: user.md, projects, agents.json, rules | `~/.hq` (private hq-state repo; only these files are committed) | built: never snapshotted |
| **Service** | Something several agents may use: an MCP server, an API, a login | `kernel/services/<name>.json` | built |
| **Grant** | Which agent may use which service, as which account | `~/.hq/secrets/auth.json` (this Mac, never in git) | built |
| **Environment** | The installed software a package's plugins need, built per machine | not yet | planned |
| **Kernel** | Runs agents and connects them: `bin/hq`, `hq-pkg`, `hq-auth`, the bridge, the adapter | this repo: `kernel/` (`bin/`, `lib/`, `adapters/`, `services/`); no agents | built |

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
`<home>/state` (`lib/hq_paths.py`), a git repo of its own. Databases are committed as text dumps (`hq-state dump`).
Personal details moved out of the packages too (2026-10-14);
`hq-pkg check --share` guards it. Third-party skills are linked from their repos (skills.json), never copied.
Published 2026-10-14 with fresh history (MIT).

**Code in kernel/** (2026-10-15). The repo is the hq folder; all code and services moved into `kernel/` (bin, lib,
adapters, PROTOCOL.md, services), so the top level shows the system's parts: `kernel/`, `agents/`, `state/`. One
clone installs hq. `agents/` and `state/` stay ignored, their own repos; `git clean -x` at the top would reach them.

**One folder** (2026-10-14). Agents and state moved into the hq folder, `agents/` and `state/`, each still its own
repo and ignored by the kernel: one place to manage, the same repo boundaries. `~/.hq` is hq's stable
address, a link to the hq folder; one resolver (`lib/hq_paths.py`, `HQ_HOME`) is the only code that knows where things
are. Logs and caches moved to `~/Library/Logs/hq` and `~/Library/Caches/hq`; snapshots stay in `agents/.store` because
an APFS clone only costs nothing on the same disk.

**This Mac's hq: ~/.hq** (2026-10-15). `~/.hq` became a real folder on the internal disk, the way `~/.claude` is
Claude Code's: what hq has lived (the hq-state repo: `user.md`, `projects/`, `projects.json`, `agents.json`,
`private-words`) and everything only this machine needs (`secrets/`, settings, job state, the cost ledger, logs,
caches, snapshots), which its `.gitignore` keeps out of git by listing only the five it commits. The hq folder's
address moved to `~/hq`. `~/.config/hq`, `~/Library/Logs/hq` and `~/Library/Caches/hq` are gone; `<hq>/state` too.
Every run can read `~/.hq`, so `bin/hq` denies the file tools `~/.hq/secrets/` (tools get secrets from `hq-auth`).
Snapshots moved to `~/.hq/store`: off the agents' disk there are no clones, so unchanged files are hard links to the
previous snapshot's (as Time Machine and `rsync --link-dest` do), and `gc` keeps the 2 newest, the good, pinned and
running versions and anything under 2 days old, on every run; older versions are in each agent's history. The
resolver keeps the older layout working while `~/.hq` is still a link.

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
`~/.hq/store/<name>@<version>/` (APFS clones on the agents' disk, else hard links to the previous one); a changed package is checked first, and a failing version never runs (the last good
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
