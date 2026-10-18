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

Projects are a level of their own (2026-10-16): a project can sit in a parent (a client or company holding several
repos, a line of research) and can have a **home**, any folder of the user's where its files already are. hq records
the pointer and never lays the folder out. A new project with no folder gets an empty one, inside its parent's home or
under the root the user chose in `hq init` (`homes` in `projects.json`, default `~/Documents`). To work on a whole
project, `hq project open ID` starts Claude Code in its home with every project it holds that is on this Mac. Agents are told the parent (one attribute on the session tag) but open its
memory or home only when the task reaches past their project, so context stays lean. A decision goes in the highest
project it holds for (`bin/project-id --info`, `hq project`).

## The model

| Part | What it is | Lives in | Status |
|---|---|---|---|
| **Plugin** | A capability: a skill, the tools it drives, and the software they need | inside an agent's `skills/` + `tools/` today | partly: no manifest or `requires` yet |
| **Role** (package) | What an agent is: identity (`agent.md`), settings, capabilities, its plugins, the skills it learned | its own git repo, `agents/<name>/role/` | built: versioned, snapshotted, committed |
| **Life** | What an agent has lived: memory, data, files, jobs | next to its role, `agents/<name>/` (the private hq-agents repo; files/ not in git) | built: never snapshotted |
| **State** | What hq has lived: user.md, projects, agents.json, rules | `~/.hq` (private hq-state repo; only these files are committed) | built: never snapshotted |
| **Service** | Something several agents may use: an MCP server, an API, a login | `kernel/services/<name>.json` | built |
| **Grant** | Which agent may use which service, as which account | `~/.hq/secrets/auth.json` (this Mac, never in git) | built |
| **Browser profile** | A set of logins and the browser that made them, opened by every browser tool an agent has; its own per agent unless granted a shared one | `browser/<name>` in `auth.json`, folder `~/.hq/browsers/<name>` (this Mac, never in git) | built |
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

**Harnesses** (`adapters/harness.py`, 2026-10-18). An agent runs on Claude Code or, with `harness:` in `agent.md`
(or `-H`), on codex, pi, agy, hermes, qwen, dsh or opencode. `bin/hq` still builds the run (prompt, snapshot, project,
directories, granted MCP servers, model, effort); only the last step differs. Callers ask for JSON, a session to resume
and a permission mode with `HQ_OUTPUT`, `HQ_RESUME`, `HQ_PERMISSION_MODE`, the same for every harness, and get Claude's
result shape back. Session ids from other harnesses are `<harness>:<id>`, so a session is only ever resumed by the
harness that made it. Settings permissions, hooks and per-request cost stay Claude-only.

**Channels** (`bin/hq-bridge`, `bin/hq-send`). Discord, one bot, a channel per agent. The channel's agent owns the
task, calls other agents as helpers, and answers in the task's thread. Telegram (2026-10-19), a bot of hq's own
(`telegram/hq`, granted to `bridge`) in the same bridge process: in a private chat, `@agent` or `/agent` picks the
agent, a reply to an agent's message continues its session, anything else goes to the chat's default agent
(`/default`; the owner's DM starts with `personal`) or the bot asks with a button per agent. No groups or files yet.

**People** (`bin/hq-auth`, 2026-10-19). Other people use the owner's hq through chat. The tables live in
`auth.json`, next to grants, so agents can't change them, one fact per table:
- `people`: who someone is (name, lang, tz) and their chat accounts (`handles`, numeric ids). One is the owner;
  `hq init` names them from git.
- `members`: agent × person, with a preset and overrides (mode, deny, model, env, helpers). Access is the row
  existing. `*` is a row for every known person; a person's own row replaces it whole.
- `presets`: named permissions. Built in: `guest` (mode `default`: only what the agent's settings allow) and
  `member` (`acceptEdits`).
- Grants keyed `<agent>@<person>`, tried before the agent's own: a person's own account for that agent.
- A profile's owner (`"person"`): logins (`login` and `browser` services, or `"personal": true`) are the owner's by
  default, keys and bots shared; `"*"` shares one on purpose. A run for anyone else never gets someone else's
  profile, whatever the grants say.

A run's person is `HQ_PERSON`: set only by entry points (the bridge from the sender's account, a schedule), unset
means the owner, inherited by every helper. `bin/hq` resolves it before anything else and fails closed. For anyone but
the owner, the membership's mode replaces the caller's (the bridge asks for `bypassPermissions`), and the run:
- stays on Claude Code;
- sees only the kernel, the agent's own folder, its pinned package and the current project;
- is denied every other agent's folder and `user.md`;
- gets `person=`, `name=`, `lang=`, `tz=` on its `<session>` tag (PROTOCOL: "Who you work for").

The plugin refuses `hq:<name>` spawns the person may not use (`--via` the calling agent: a helper is allowed when
the caller's membership lists it). The bridge maps a sender to a person (`whois`), links accounts with `/link CODE`
(from `hq auth invite`), checks access before starting, and gives a Discord thread to the person who started it.
Others are turned away from it, because its session holds what the agent saw for them. `hq auth people [ID]
[--matrix]` shows everything: each person's accounts, owned profiles, the agents they reach and how, and the
account each service would really use in their runs.

Not a sandbox: everything runs as one macOS user, so a run with a free shell can unset `HQ_PERSON` and become the
owner. Guests get no free shell; never give one to someone you wouldn't give the Mac.

Known gap: an agent called as an `hq:<name>` subagent shares the calling session's MCP servers, so grants only
apply to full `hq <agent>` runs.

## Planned

**People and channels** (designed 2026-10-19, in build order; most users will use the owner's hq remotely, through
chat). Items 1–5 all change `hq-bridge`, so build them one after another, item 1 first. After that, 4, 3, 11 and 12
touch different files and can be built in parallel (flow).

Channels:
1. **Split the bridge.** One core for people, access, routing, sessions and the queue, plus a small adapter per
   platform: receive, post as the agent, thread, stop. Discord and Telegram each carry a copy of that core today.
   Discord moves first, behaving exactly as now.
2. **Rooms and `@mentions` everywhere.** A room is where people talk (a DM, `#home`, `#work`), keyed by bot and chat
   id, with an optional default agent. `@agent` picks; with no mention, the thread's last agent, then the room's
   default; with none, ask "who should take this?" (never guess). Threads become `{agent: session}`, the first
   agent mentioned owns the task, and the others are helpers. Today's agent channels stay as rooms. On Discord, a
   role per agent gives `@` autocomplete.
3. **Telegram, finished:** groups (the household one; privacy mode means commands or mentions only), files both
   ways, Markdown, and the queue, stop and corrections from Discord.
4. **Slack:** one app in Socket Mode. On the free plan: 10 apps, 90-day history, no guest accounts (so keep
   private agents' channels private).
5. **Several bots per platform:** a grant holds a list (`"bridge": {"telegram": ["telegram/hq", …]}`), one connection
   each, every connection restarting on its own.

Auth:

6. **Retire the old Discord settings.** Turn off `HQ_DISCORD_REPLY_TO=anyone` (today every server member runs as the
   owner). Make each `HQ_DISCORD_ALLOWED_IDS` entry a person or drop it, and read the owner from `people` instead
   of `HQ_DISCORD_OWNER_ID`.
7. **Only the owner gets a free shell:** `hq auth member … mode=bypassPermissions` refuses unless `--trusted`.
8. **`hq doctor` checks the people setup:** memberships naming missing agents, unknown people in grants, login
   profiles marked shared.
9. **Rename a person** (`hq auth person <id> id=<new>`, carrying memberships, grants and owned profiles along).
10. **An `admin` level** (everything but the owner's logins, folder isolation off). On hold until the owner asks.

Remote users:

11. **Sign-in links** for a person's own accounts: an OAuth link sent in chat (Google first), with the token stored
    in the Keychain as `google/<person>` and granted `agent@person`.
12. **Cost per person:** a `person` column in the cost ledger, and a monthly cap per membership (`budget=`).
13. **Memory per person:** `agents/<a>/memory/` stays shared with the agent's members, `memory/people/<id>/` holds
    what it learned from one person, and `user.md` becomes `people/<owner>.md`. This is a structural move, so
    propose it before doing it.
14. **Shared browser logins:** the owner's browser profiles hold the agents' accounts. A profile opens in one run
    at a time, so each run gets an APFS clone, thrown away after (a login refreshed during a run is lost).
    `chrome-agent` should become a browser profile (`browser/agent`, living in the Chrome app). It can't be merged
    into the jev-browser profile yet: yt-dlp couldn't decrypt 208 of that profile's 670 cookies, which are encrypted with a
    different key.

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
