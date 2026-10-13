---
name: new-agent
description: Create a new hq agent, or change or audit an existing one, following the repo's conventions and the one-owner, lean-context rule.
---

# Create an agent

`<hq>` is the hq folder from your instructions.

## 1. Understand the job (one round of questions, with defaults)
- What is it for, in one sentence? What are 3 concrete things the user will ask it?
- What is **not** its job, and which existing agent owns that? (`ls <hq>/agents`, read their descriptions.)
- Where does its data live (files, a database, an API, a website)? Is it state (read every time) or memory?
- What may it change without asking? What must it never do (spend money, send messages, delete)?
- Which accounts or keys does it need? Ask for the name and location only, never the value
  (keys live in `~/.config/<tool>/env`, `~/.config/hq/env`, or the Keychain).
If the user already said enough, skip straight to building and state your assumptions.

## 2. Collect before building (the user expects this)
Survey what already exists for the job, then pick, before writing anything yourself:
- On this Mac: `find ~/.claude/skills ~/.codex/skills ~/.codex/.tmp/plugins <hq>/agents ~/.claude/plugins/cache
  -name SKILL.md -not -path '*/.trash/*'`, grep name/description for the job's keywords; CLIs on PATH
  (`which …`); logged-in tools (`codex login status`, `gh auth status`, `gcloud auth list`); key *names* in
  `~/.config/*/env`.
- On the web: the galleries and directories in `sources.md` (taste first: skillry, open-design; scored: tessl;
  usage: skills.sh), GitHub "claude skills <job>", and well-known local CLIs for the job.
- **Hermes** (`~/.hermes/profiles/*/skills/`, `~/.hermes/*.db`, `~/.hermes/cron/jobs.json`) often already does the
  job (it held a shared expense ledger before house existed). Read its SKILL.md and schema, ask
  whether to reuse, import, or replace it, and never write into `~/.hermes` without asking.
- For each candidate: licence, cost (MCP/sign-in/API key/money), and whether another agent owns it. A skill
  from a public GitHub repo is **linked, never copied**: add it to the agent's `skills.json` (`repo`, `path`, `ref` =
  the full commit sha, `license`) and run `hq-pkg fetch <agent>`; it lands in `skills/<name>/`, git-ignored. Only
  skills you write yourself are files in the package. Proprietary or unclear licence → learn the idea, write your own.
- Test the tools you keep on real inputs, including one that should fail. Report what you took, built and
  skipped, and why.

## 3. Scaffold
`<hq>/bin/hq-new <name> "<description>"`
- name: short, lowercase, one word if possible (`image`, `opportunity`).
- description: one line, starts with what it is, then "Use to …" with the trigger phrases; no `: ` inside.
It creates agent.md with TODOs, capabilities.yaml, settings.json (every plugin off), memory/ and skills/.

## 4. Fill in
- **agent.md:** replace every `TODO(builder)`. Identity in one paragraph; "How you work" 3–6 bullets (state vs
  memory, approvals, its quality bar); skills table; "Not yours" naming the owning agents.
- **capabilities.yaml:** tools, state locations, credentials by name and where they live, access level.
  Add `global_skills: true` only if it truly needs skills from `~/.claude/skills` (designer/video do; most don't).
- **settings.json:** `permissions.allow` for the agent's own tools and write folders (memory and
  learned skills: `Edit(/{{HOME_DIR}}/memory/**)` *and* `Edit(/{{HOME_REAL}}/memory/**)`; Claude Code matches the
  symlink-resolved path, so the `{{HOME_DIR}}` rule alone still prompts for new files), or terminal one-shots and
  `hq:<name>` calls stall on approval. Absolute paths need `//` (`Edit(//Users/…/memory/**)`); a single `/` is
  relative to the settings file; use Edit rules, not Write. Turn a plugin back on only if the agent needs it (`"impeccable@impeccable": true`). Add
  `permissions.deny` for paths it must not edit.
- **Model and effort:** in `agent.md`'s frontmatter, not settings.json, so subagent calls get them too:
  `model: opus|sonnet|haiku` and `effort: low|medium|high|xhigh|max`. Lookups over the agent's own tools and data
  (house, finance) do well on sonnet at low or medium; design, diagnosis and agent-building want opus at high. Check
  what it costs with `hq cost agent <name>` after a few runs.
- **Services and credentials:** an MCP server, API key or login another agent could also use is a shared service:
  `shared/services/<name>.json` (`kind` mcp | cli | login, how to start it, the env var names it needs; never a
  value). The agent asks for it with `needs: [<name>]` in capabilities.yaml; the user grants it an account with
  `hq-auth grant <agent> <service> <service>/<account>` (`hq-auth ls` shows who has what; `hq-auth set` stores a
  key in Keychain). bin/hq starts only granted MCP services and injects secrets into that server process alone; a
  cli tool gets its key with `<hq>/bin/hq-auth get --for <agent> <service> <VAR>`. A server only this agent will
  ever use, with no secret, can still go in its own `mcp.json`.
- **Editing an existing agent:** `touch <hq>/agents/<name>/.editing` before a change that spans several files,
  `rm` it when done and `<hq>/bin/hq-pkg check <name>` passes; runs keep the last good version meanwhile.
- **Paths in prompts and settings:** use `{{AGENT_DIR}}` for the agent's own skills and tools (runs are pinned to
  a read-only snapshot of the package) and `{{HOME_DIR}}` for memory and data. A tool finds its data through the
  snapshot's `.home` file or `HQ_AGENT_HOME`, never its own folder (see `agents/personal/tools/links.py`).
- **tools/**: deterministic code it runs (stdlib Python or a small script). Test it before writing the skill.
  Snapshots are read-only but keep execute bits (fixed 2026-10-13), so `{{AGENT_DIR}}/tools/x` runs if the working
  copy is `chmod +x`; `python3 {{AGENT_DIR}}/tools/x.py` also works. Give the tool a data-dir env override
  (`<NAME>_DATA`) so you can test it, and the agent, against scratch data. Have it print anything the model tends
  to get wrong (weekday labels, totals, balances) rather than leaving the model to work it out.
- **Data:** `agents/*/data/` is gitignored: state stays on this Mac and doesn't follow the user's other devices.
  Don't promise git sync; a Notion mirror or other remote is the cross-device copy.
- **Scheduled jobs** (daily reminders, polling): a launchd plist in `~/Library/LaunchAgents/dev.hq.<name>.plist`
  running `~/.config/hq/bin/hq-uv run --quiet --script <live tool path> …` (that uv has Full Disk Access to the
  SSD; see `dev.hq.monitor`). Run plain code, not an agent, when no judgement is needed. Test with
  `launchctl kickstart gui/$(id -u)/dev.hq.<name>` and read its log.
- **skills/<task>/SKILL.md**: one per kind of task: when to use it, the steps, the commands, what "done" looks
  like, and the facts-must-be-checked rule if it states facts. Add it to the agent.md table.
- **memory/MEMORY.md**: seed with what the user told you that will stay true (preferences, accounts, rules).
- **Other agents:** add one line to the "Not yours" of any agent whose work this one takes over.

## 5. Verify (always, and report the numbers)
`<hq>/bin/hq-pkg check <name>` validates the package; `<hq>/bin/hq <name> --inspect` starts one run and prints its tools, MCP servers, skills and plugins.
Expect ~24 built-in tools + `hq` + only its own MCP servers (all `connected`), 0 skills unless `global_skills`,
plugins = hq + Claude Code's built-ins. Anything else: fix it before reporting.
Then give it one real task from step 1 (`<NAME>_DATA=<scratch> <hq>/bin/hq <name> "…"`) and check the answer and
the records it wrote. If it stalled, read its transcript (`grep -l '<task text>' ~/.claude/projects/*/*.jsonl`,
then list tool_use/tool_result) to see exactly what was denied. Delete any session file the test run wrote,
since it describes scratch data.

## 6. Bring it online
- Discord: the bridge creates `#<name>` within a minute (it rescans agents). Say so.
- In Claude Code sessions it appears as `hq:<name>` after the next session start.
- Report: what it does, what it won't do, its tools and their context cost, what the user must still provide
  (logins, keys), and a first thing to try.

# Change or audit an agent
- Read its agent.md, capabilities.yaml, settings.json, mcp.json, skills, and `hq-auth ls`. Run the verify step and compare with
  what it actually uses. Remove what it doesn't use; move work another agent owns to a helper call.
- Never edit its `memory/` (that's the agent's own). Report before/after numbers.
