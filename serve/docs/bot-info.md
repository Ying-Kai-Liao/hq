# Bot details: API contract

The detail page of a kith bot (role, memory, skills, tools, MCP servers, projects, schedules, cost, model and
package version) is drawn from what `kith <agent> --info-json` prints. The host passes it through; the apps draw it.
Same path as place folders (`place-folders.md`): kernel JSON, host API, apps.

All methods are `POST /api/<method>` (loopback bearer token) or the same call over a phone's E2E channel. They are
read-only and none is in `LOCAL_ONLY` (`api/devices.rs`): a paired phone with the Control scope may read and search
a kith bot's memory. These are the agent's own files, not Kith's bot memory (`memory`, `memoryCall`).

## `kithInfo { botId, refresh?: bool }`

```json
{ "info": { ...info-json... } | null, "error": "why", "fetchedAt": 1760000000000 }
```

- `info` is null, with no `error`, for a bot that is not a kith agent (no `hqAgent`) and for a group.
- `info` is null with `error` when kith is missing, fails, times out (45 s), prints something that isn't a JSON
  object, or no longer lists the agent. The call is never an error status for these.
- An unknown `botId` is HTTP 400.
- Per agent, a run is reused for 30 s (a failed run for 3 s). Older answers are returned at once and refreshed behind the call; the first
  call waits for kith. Two clients asking together cause one run. `refresh: true` runs kith now, or takes the answer of a run already in flight.
- `fetchedAt` is when kith ran, in unix milliseconds.

### info-json (version 1)

Passed through as is: read the keys you know and ignore the rest. Only `memory.dir` is the host's business.

```
{ "version": 1, "agent", "description", "harness", "model"|null, "effort"|null, "permission_mode"|null, "home",
  "role": { "path", "intro", "sections": [ { "title": "Not yours", "text" } ] },
  "package": { "version"|null, "remote"|null, "dirty", "unpushed", "pinned"|null },
  "skills": [ { "name", "description", "source": "package"|"learned"|"global" } ], "tools": [str],
  "mcp_servers": [ { "name", "kind", "command"|null, "url"|null } ], "plugins": [str],
  "projects": [ { "id", "files", "modified"|null } ],
  "schedules": [ { "id", "cron", "task", "paused", "last_run"|null, "last_status"|null, "next_run"|null,
                  "source": "kith"|"launchd" } ],
  "cost": { "currency": "USD", "today", "week", "month", "all", "requests_month",
            "by_model_month": [ { "model", "usd" } ], "since"|null } | null,
  "memory": { "dir": "/abs", "files": [ { "path" /*relative*/, "bytes", "modified" } ], "total_bytes" },
  "errors": { "<key>": "reason" } }
```

Values to know: `schedules[].source` says where a job comes from (`kith` = kith-sched, `launchd` = the agent's own LaunchAgent, whose `id` is its Label and `last_status` is always null); apps may ignore it.
Also: `schedules[].last_status` is `"running"`, `"done"` or null (never ok/failed), and `package.version`
is a fingerprint hash such as `393def5f55`, not a semver number. `errors` names the parts kith could not read (for example `cost`), so a page can say so instead of showing nothing.

## `kithMemoryFile { botId, path }`

```json
{ "path": "notes.md", "text": "...", "bytes": 19, "modified": 1760000000000, "truncated": false }
```

`path` is relative to `info.memory.dir` (the `path` of a `memory.files` entry or of a search hit). Reads stop at
512 KB: `text` is the first 512 KB, `bytes` the file's size, `truncated` true.

HTTP 400, with a message, for: an unknown bot, a bot that is not a kith agent (or whose agent is gone), an empty
path, an absolute path, any `..`, a path that resolves (through symlinks) outside the memory folder, a missing
path, and anything that is not a regular file.

## `kithMemorySearch { botId, query, limit?: int }`

```json
{ "hits": [ { "path": "notes.md", "line": 3, "snippet": "..." } ], "error": "why" }
```

Runs `kith memory search <query> --agent <name> --json -n <limit>`; `hits` are kith's, `path` relative to the memory
folder (`line` may be null). `limit` defaults to 20, at most 50. An empty query gives `{ "hits": [] }`. When kith
fails, `hits` is empty and `error` says why. Same 400 for an unknown or non-kith bot as above.

Each hit gets `"openable": bool`, added by the host: true only when `kithMemoryFile` would accept the hit's `path`.
Hits in the memory folder have relative paths. Learned-skill and shared-file hits keep the absolute path kith gives
and are `openable: false`; show them without a link to open.

## Memory files and tidy-ups (a kith agent's bot)

The files are the truth: `agents/<name>/memory/**` and the shared user layer (`user.md`, `people/`, `projects/` in the
state folder). Every call below takes `botId` (same 400 for an unknown or non-kith bot, or one whose agent is gone) and,
for a file, `shared` (bool: the user layer; default false: the agent's own `memory/`) and `name` (the path inside that
layer, `MEMORY.md`, `people/mum.md`; anything that isn't a Markdown memory file is a 400).

| Method | Arguments | Answer |
| --- | --- | --- |
| `kithMemoryList` | | `{ agent: [file], shared: [file] }`, `file` = `{ name, shared, path, size, modified }` |
| `kithMemoryRead` | `shared`, `name` | `{ name, shared, text, bytes, modified, truncated?, exists }`; a file not made yet is `text: ""`, `exists: false`; at most 512 KB |
| `kithMemorySave` | `shared`, `name`, `text` | `{ version, warnings }`: Kai's save, never refused (a size cap or a big drop only warns); `version` is `null` when nothing changed |
| `kithMemoryHistory` | `shared`, `name`, `limit?` (50, max 500) | `{ name, shared, versions: [version] }`, newest first |
| `kithMemoryDiff` | `shared`, `name`, `from?`, `to?` (version ids) | `{ from, to, diff }`; by default the version before the newest to the newest; `diff` has `- `/`+ ` lines, `  ` context, `…` gaps |
| `kithMemoryRestore` | `shared`, `name`, `version` | `{ version, warnings }`: the file becomes that version's content, as a new version (cause `restore`) |
| `kithMemoryTidyUps` | `limit?` (20, max 100) | `{ tidyUps: [tidyUp] }`, newest first |
| `kithMemoryUndoTidy` | `id` | `{ restored: [label], refused: [{ file, reason }], undone }` |

`version` = `{ id, at, author: "kai"|"agent"|"tidy"|"unknown", authorBot, cause: "edit"|"delete"|"restore"|"undo"|"tidy"|"baseline", deleted, bytes, lines }`;
`unknown` is a change made outside the hook (an editor, a shell). `tidyUp` = `{ id, at, undone, files: [{ name, shared, version }], changes: [{ kind, file, shared, text, was }] }`;
`kind` is `added`, `archived`, `reviewed` (`text` the new line, `was` the old), `noted` (a line appended to a note) or `indexed` (the MEMORY.md line naming a note).
`kithMemoryUndoTidy` puts every file the run wrote back to what it was before; a file that changed after the run (the
agent, Kai or a later tidy-up) is left alone and named in `refused` with the reason, and the run stays not undone until its
files are all back. HTTP 400 when it can restore nothing. Calls that change a file also emit the bot, so a page refetches.

Deprecated names, kept for app builds that predate the "Tidy" rename: `kithMemoryDreams` (same as `kithMemoryTidyUps`, and its
response also carries the list as `dreams`), `kithMemoryUndoDream` (= `kithMemoryUndoTidy`), `undoDream` (= `undoTidy`) and
the `dreams` field of the `memory` response (= `tidyUps`). Old version rows say author/cause `dream`; they are read as `tidy`.
