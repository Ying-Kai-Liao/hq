# Place folders: API contract

Every place a bot talks in (its own chat, a thread or task, a member's lane in a group) can work in an hq project
or a folder the user picked. The agent then loads that project's context (CLAUDE.md, codebase.md, verify.md,
decisions, project memory) the way `hq <agent> -p <project>` does in a terminal.

All methods are `POST /api/<method>` (loopback bearer token) or the same call over a phone's E2E channel. A paired
phone needs only the Control scope: none of these methods is in `LOCAL_ONLY` (`api/devices.rs`).

## Which folder a place works in

First match wins:

1. the place's own pick (`setPlaceFolder`, or `project`/`folder` on `send`),
2. the bot's default project (`BotConfig.project`, set with `createBot` / `updateBot`),
3. the bot's `cwd`, which is the managed workspace unless the user gave the bot a folder,

so a bot and a place with nothing set work exactly as before.

A group has no folder. A member's lane in a group is a place of that member: it takes the member's own pick for
the group's lane (`setPlaceFolder` with `botId` = the member and `chat` = the group), else the member's default.

## The `folder` object

Wherever a client reads a place, it gets `folder`:

```json
{ "kind": "project" | "folder" | "workspace",
  "project": "hq",                 // only kind "project"
  "path": "/abs/path" | null,      // where the agent works; null while a project's folder isn't known yet
  "name": "hq",                    // project id, folder name, or "Workspace"
  "inherited": false,              // true: the place has no pick of its own
  "missing": true }                // only when the project has no folder on this Mac, or the folder is gone
```

`kind` is `workspace` when nothing is picked and the bot works in its managed workspace, `folder` for a picked
folder or a bot given its own folder. When `missing` is true the agent works in the bot's `cwd` instead, and says
so in the chat.

Where it is: `history` (`folder` of the bot's own chat), `thread` (`folder` of that thread), `botConversation`
(the bot's own chat), and every bot payload (roster, `bot` events): `bot.folder` is the bot's own chat. A thread's
folder is read with `thread`; after `setPlaceFolder` the bot event fires, so refetch `thread` or use the
response. `folder` is null for a group's payloads.

## Methods

### `projects`

`{ "refresh"?: true }` -> `{ "projects": [ { "id", "path": string|null, "paths": [string], "parent": string|null, "exists": bool } ], "error"?: string }`

hq's registry (`hq project ls --json`, a few seconds cached). `path` is the project's home if that is a folder
here, else the first path that is; `exists` is false when none is. Without hq, or when it fails: `projects: []`
and `error` with the reason, never an error status.

### `recentFolders`

`{}` -> `{ "folders": [ { "path", "name", "project": string|null } ] }`

The folders and projects places were set to, newest first, at most 12. A folder that is gone is left out.

### `listDirs`

`{ "path"?: string, "showHidden"?: bool }` -> `{ "path", "parent": string|null, "isGit", "project": string|null, "dirs": [ { "name", "path", "isGit", "project": string|null } ], "roots": [ { "name", "path" } ] }`

Browsable places are the user's home (the default) and each drive mounted under `/Volumes`. `path` is resolved
(symlinks, `..`) before it is checked; anything outside the roots is refused (HTTP 400, "outside your home folder
and the drives mounted on this computer"). `/Volumes` itself lists the drives. `parent` is null at a root, so
"up" stops there: jump to another root with `roots`. Dot folders and system folders at the top of a root
(`Library`, `Applications`, `System`, ...) are left out unless `showHidden`. `project` is the id of the project
registered at that folder.

Impact on the existing callers (the bot editor's folder picker on desktop and iOS): the response keeps its shape
and adds fields; "up" at the home folder no longer leads to `/Users`; a path outside home and the drives now fails.

### `setPlaceFolder`

`{ "botId", "threadId"?, "chat"?, "project"? | "folder"? | "clear"? }` -> `{ "folder": <folder object> }`

`botId` names the bot (for a group lane, the member). The place is its own chat, or the thread on message
`threadId`, or the group lane `chat` (the group's id). Give exactly one of:

- `project`: a registered hq project id (checked against `hq project ls`),
- `folder`: an absolute path inside the browsable roots,
- `clear`: forget the place's pick, so it inherits again.

The response is the place's new effective folder. When the folder the place works in changes, the place starts a
fresh session: its stored session is dropped (never `session/load`ed), a turn still running there stops, its agent
process restarts in the new folder on the next message, and a turn cut off by a host restart does not resume. The
bot's other places are untouched. Setting what the place already works in is a no-op (no reset). Two clients setting
at once: the last write wins. The `bot` event fires, and the pick goes to `recentFolders`.

Errors (HTTP 400): unknown bot or thread, unknown project, folder outside the roots or not a folder, hq missing.

### `registerProject`

`{ "id", "path" }` -> `{ "project": <as in projects> }`

Runs `hq project add <id> <path>`. `id` is lowercase words joined by single dashes; `path` a folder inside the
browsable roots. hq's own error passes through (HTTP 400), for example when the id exists.

### Starting folder on creation

- `send` takes `project` or `folder` (as `setPlaceFolder`, no `clear`) and applies it to the place the message runs
  in before the turn starts: with tasks on, a message that opens a task puts that new task in the folder, with no
  reset round trip; in a thread it is that thread; otherwise the bot's own chat. A bad value fails the send before
  anything is saved.
- `createBot` / `updateBot` take `project` (the bot's default project; `null` or `""` clears it). Changing the
  default (or the bot's `cwd`) restarts only the places that follow it; places with their own pick keep working.

## What the host runs

| place | hq bots | other backends |
| --- | --- | --- |
| project | `hq <agent> --launch-json -p <id> ...` run in the project's folder; ACP `cwd` = that folder | the project's folder as `cwd` |
| folder | `hq <agent> --launch-json ...` run in the folder, no `-p` (hq finds a project from the cwd) | the folder as `cwd` |
| nothing | as before (hq's `cwd`, else the bot's folder) | the bot's `cwd` |

The project's folder is its home if that is a folder here, else its first path that is. If the project has none
on this computer, the agent works in the bot's folder, `-p` is still passed, and the chat gets a notice. A picked
folder that no longer exists falls back the same way, without `-p`. A thread in a different folder than the bot's
own chat starts fresh instead of forking the main session.
