# Memory per person

Status: built 2026-10-19 with the recommended answer to each decision below (the owner's memory stays in place,
a shared part, outputs per person, memory kept when a person is removed). Kept as the design record.

## Why

hq lets other people use the owner's agents through chat (`hq auth member`). Memory was built for one user, and
today a run for someone else (`HQ_PERSON=sam`):

- **sees the owner's memory.** `bin/hq` puts `memory/MEMORY.md` in every run's prompt and gives the run the whole
  agent folder (`--add-dir "$home"`). Only other agents' folders and `user.md` are denied.
- **writes into it.** What the agent learns about Sam lands in the same `MEMORY.md` and topic files, so the owner's
  next run reads Sam's facts as the owner's own.
- **collides on sessions.** `memory/sessions/ID.md` is overwritten at the end of every call, so Sam's call on a
  project wipes where the owner's call left off, and the other way round.
- **mixes outputs.** `files/ID/` holds both people's renders and exports.
- **could search past the denials** (closed 2026-10-19). `hq-memory search` is a command runs may use without
  asking, and it read `user.md` and, with `--all`, every agent's memory.

## Target

An agent's memory has three parts: what it knows about its craft (shared by everyone who uses it), what it knows
about each person, and the owner's part, which stays where it is.

```
agents/<agent>/memory/
  MEMORY.md, topic files, projects/, sessions/   the owner's, as today (no move)
  shared/                                        craft and facts every member may see: MEMORY.md, topic files
  people/<id>/                                   one person's: MEMORY.md, topic files, projects/, sessions/
agents/<agent>/files/people/<id>/                that person's outputs (files/ID/ stays the owner's)
~/.hq/people/<id>.md                             who a person is, shared by all agents: their user.md
~/.hq/user.md                                    the owner's, as today
```

What each run sees:

| | Owner's run | Sam's run |
|---|---|---|
| In the prompt | `memory/MEMORY.md` + `memory/shared/MEMORY.md` | `memory/shared/MEMORY.md` + `memory/people/sam/MEMORY.md` |
| Reads | everything, as today | `shared/`, `people/sam/`, `files/people/sam/`, `~/.hq/people/sam.md` |
| Writes | its own memory, `shared/` | `people/sam/`, `shared/` (craft only), `files/people/sam/` |
| Denied | — | the owner's memory files, `people/<anyone else>/`, `files/` outside their own, `user.md`, other people's `people/*.md` |
| Session file | `memory/sessions/ID.md` | `memory/people/sam/sessions/ID.md` |

The owner's runs don't load other people's memory into context. They can still read it when asked (it's the
owner's Mac).

`data/` stays the agent's. Some data is shared on purpose (house's household), and an agent that needs
per-person data decides that in its own role.

## Decisions for the owner

1. **Where the owner's memory lives.** Recommended: it stays in `memory/` and only the new parts are added
   (above). The alternative moves every agent's memory into `memory/people/<owner>/` and `user.md` into
   `people/<owner>.md`: symmetric, but it moves 15 agents' memory and every `{{STATE}}/user.md` reference (PROTOCOL,
   `bin/hq`, `hq-memory`, `hq-init`, `hq-new`, `hq-state`, `hq-doctor`, and 17 lines in agents' roles), for no gain
   to the owner.
2. **A shared layer at all.** Recommended: yes, `memory/shared/`, for lessons about the craft ("this voice
   mispronounces X", "renders over 4K time out"). The rule in PROTOCOL: never a fact about a person there. Without
   it, what an agent learns in Sam's runs never helps anyone else.
3. **Separate outputs.** Recommended: yes, `files/people/<id>/`.
4. **When a person is removed** (`hq auth person sam --rm`): keep their memory and files (the owner deletes them
   by hand) or delete them with the person. Recommended: keep, and `hq doctor` lists memory of people who are gone.
5. **Backups.** Other people's memory goes into the owner's private agents repo and `people/*.md` into the private
   state repo, both on GitHub when backups are on. Fine for family; worth saying to anyone else you invite.

## Steps

One at a time; each ends with its check.

1. **Close the search hole** (done 2026-10-19, before the rest: for now it searches the agent's whole memory, which the run sees anyway; narrow it to `shared/` and `people/<id>/` with step 2). `hq-memory` in a run
   whose `HQ_PERSON` isn't the owner searches only that agent's `shared/` and `people/<id>/`, never `user.md`,
   other agents or `--all`.
   Check: as a test person, `hq-memory search --all <a word in user.md>` finds nothing.
2. **Paths in `bin/hq`.** For a person: `mkdir -p` their folders; a `{{MEMORY_DIR}}` placeholder (the owner:
   `memory`; a person: `memory/people/<id>`) and `{{SHARED_MEMORY}}`, `{{FILES_DIR}}`, `{{PERSON_FILE}}`; the
   prompt gets the two `MEMORY.md` files from the table; `WRITABLE` and `--add-dir` narrowed to their folders.
   Deny rules list the owner's memory (`memory/*.md`, `memory/projects/**`, `memory/sessions/**`) and each other
   person's folder, by logical and resolved path (deny beats allow in Claude Code, so the run gets an explicit list,
   not a broad deny with exceptions).
   Check: the owner's prompt and settings for one agent are byte-for-byte what they were before. A test person's
   run can't Read `memory/MEMORY.md`, and its session file lands in `people/<id>/sessions/`.
3. **PROTOCOL.** "What goes where" uses `{{MEMORY_DIR}}` (the same text for everyone), plus a row for
   `{{SHARED_MEMORY}}`: craft only, never about a person. "Who you work for" points at `{{PERSON_FILE}}` for the
   person's profile.
   Check: a test person's run on a scratch agent writes their facts to `people/<id>/` and a craft lesson to
   `shared/`.
4. **Rename and removal.** `hq auth person <old> id=<new>` also moves `memory/people/<old>`, `files/people/<old>`
   and `people/<old>.md` for every agent. Removal follows decision 4. `hq doctor` flags `people/<id>` folders and
   files for ids that aren't people.
   Check: rename a test person and their folders follow; the doctor is clean afterwards.
5. **Docs:** architecture.md (People), codebase-map.md (placeholders), the builder's new-agent skill if it names
   memory paths.

Test everything in a throwaway HOME with a scratch agent first, then on one real agent, then on all.

## Not in this plan

- Per-person data for agents that need it (decided in each agent's role).
- Moving the owner's memory (decision 1's alternative).
- Isolation beyond Claude Code's path rules. A run with a free shell can still read anything the macOS user can;
  members don't get one (`--trusted`).
