---
name: thread-writers
description: Model-checks (TLA+/TLC) that one thread has one writer at a time. Use when a change touches kernel/bin/kith-sessions, the `--resume` / take-over parts of kernel/bin/kith, serve/host/src/terminal/, serve/host/src/api/threads.rs, the thread `send` in api/bots.rs, the host turn queue and start in agent/bot/{queue,turn,session}.rs, working_lanes in hub/actors.rs, or when a bot guest's `kith ask --thread` is wired to a thread. Also use to answer "can two things write to this conversation?".
---

# Thread writers: one writer per thread

A thread is one Claude session. Four things can write to it: a terminal `kith <agent>` (including `--resume`),
an app `send` (the host runs a turn), the host's queue starting a turn later, and (designed, not built) a bot
guest's `kith ask --thread`. Two writers on one Claude session fork or corrupt the conversation. That is a
question of the order of steps, so it is checked with TLA+ (TLC), not with tests.

The model is `verification/threads/Threads.tla`. This skill is the only documentation; there is no README.

## Run it

```
verification/threads/run.sh                       # all rows of checks.tsv, about 15 s once the tools are cached
verification/threads/run.sh --show VARIANT PROP   # TLC's full output (the counterexample) for one row
verification/threads/drift.sh                     # which covered files changed since the sync commit
```

CI runs `run.sh` (job `thread-writers`) on pull requests and pushes that touch `verification/threads/`, this skill, or the covered code (the files `drift.sh` lists).

`run.sh` exits 0 only when every row of `verification/threads/checks.tsv` (variant, kind, property, expected
pass/fail) came out as expected. Tools are pinned and sha256-checked: `tla2tools.jar` v1.7.4 (MIT) and, only when
no Java 11+ is on PATH, Temurin JRE 21.0.9+10; both are cached under
`${XDG_CACHE_HOME:-$HOME/.cache}/kith-verify/` and nothing else is installed (no brew, nothing under /usr). On
macOS the `/usr/bin/java` stub does not count (`/usr/libexec/java_home` must succeed). In CI an existing Java is
used. First run downloads about 60 MB.

## Sync commit

**Last confirmed to describe the code: `b523caf7dcda3207e281aa7894353ed211e8ad7d`** (origin/main, after the merge
of #128 host and #120 kernel). The same sha is in `drift.sh` (`SYNC=`). Move it only after you have confirmed that
the model describes the code at the new commit (steps below), and change both places.

## What is promised, and the harm if not

| Property (in Threads.tla) | Plain sentence | Harm |
|---|---|---|
| `OneWriter` | At most one of: a live terminal session, a running host turn holds the thread. | Two Claude processes on one session fork or corrupt the conversation. |
| `TakeoverOnlyWhenIdle` | A take-over never SIGTERMs a terminal that is working on a turn. | The user loses the terminal's half-finished turn. |
| `NoForeignSignal` | A take-over never signals a process that is not the session's (reused pid). | An unrelated process is killed. |
| `ResumeRefusedWhileTurnRuns` | `kith <agent> --resume` refuses while the host runs a turn in that thread. | Terminal and app write at once. |
| `ResumeRefusedWhileOpen` | `--resume` refuses while the registry's terminal is live. | Two terminals on one session. |
| `SendRefusedWhenHostSeesTerminal` | A send is refused (409 `liveInTerminal`) while the host's copy of the registry says the terminal is live or a take-over runs. | App writes into a terminal's session. |
| `ContinuesLastSession` | A host turn with no terminal open starts on the session the last writer left. | The app continues an old branch and the terminal's turns are lost from its context. |
| `CacheNeverStale` | A host turn never starts on a cached session the terminal has written to since (`forget_loaded`). | The agent answers without seeing what the terminal did. |
| `ResumeNeverWhileSendPending`, `ResumeNeverWhileOtherTerminal`, `SendNeverWhileTerminalClaims` | The strict forms: refusals judged on what is true, not on what the checks can see. | They are the findings below. |
| `BotRefusedWhileHeld` | DESIGN: a bot's ask is refused while a terminal holds the thread or a take-over runs. | Bot and terminal write at once. |

"Holds" = a terminal whose claude process is live (idle, busy or being ended). A running host turn also holds.
The `Never*` rows in `checks.tsv` are reachability probes: they must FAIL, proving the what-if run can do a host
turn, a bot turn, a busy terminal and a take-over (a pass elsewhere is not vacuous).

## Coverage record (file -> function -> model action)

| Code | Model action |
|---|---|
| `kernel/bin/kith-sessions` `resolve()`: `host_call('resolveThread')`, `hostBusy` die, `live_pid(e)` die | `TermResolve` (`ResumeChecksHostBusy`, `ResumeChecksOpen`) |
| `kernel/bin/kith` `--resume` block (`eval "$(... resolve ...)"`), then `exec kith-sessions run -- claude` | `TermResolve` then `TermUp` (the launch gap, `LaunchIsInstant` removes it) |
| `kernel/bin/kith-sessions` `record()` (SessionStart hook, `write_atomic`, one file per session id, pid replaced by a later terminal; `resumedFrom`) | `TermHook` (incl. fork: new session id) |
| claude's `~/.claude/sessions/<pid>.json` status idle vs other; user prompt and end | `TermPrompt`, `TermDone`, `TermExit` (a crash may leave a ghost: pid reused) |
| `terminal/sync.rs` `before_send_blocking()` (via `api/bots.rs` `send` -> `terminal::before_send`): no `info` -> Ok; `taking` or `liveness().is_live()` -> 409; then `stale` delete + `forget_loaded` | `AppGate` (`SendChecksLive`, `TakingBlocksSend`, `GateNeedsInfo`) |
| `api/bots.rs` `send`: save entry, `send_cmd(Cmd::Send)`; `agent/bot/queue.rs` `on_cmd` `Cmd::Send` pushes `Queued::User` | `Enqueue` (a second step after the gate) |
| `agent/bot/queue.rs` `next_in_queue` -> `turn.rs` `start_turn` (`BotStatus::Working`); nothing re-checks the terminal | `HostStart` |
| `turn.rs` turn end / Stop; `hub/actors.rs` `working_lanes()` (only RUNNING turns are "hostBusy") | `HostEnd`; `hr` |
| host restart | `HostRestart` (queue, `taking`, actor cache lost; kv stays) |
| `terminal/sync.rs` `take_over()` / `take_over_inner()`: `taking.insert`, liveness of `info(...)`, write `.taken` | `TakeBegin` |
| `take_over_inner`: "Re-checked just before the signal" | `TakeRecheck` |
| `registry::terminate` (SIGTERM, after the recheck) | `TakeSignal` (`TakeoverAtomic` merges it with the recheck: what-if) |
| `take_over_inner`: wait for `pid_runs` (`EXIT_WAIT`), `import`, live CAS, `stale` delete + `forget_loaded`, `set_writer` | `TakeFinish`, `TakeTimeout` |
| `registry.rs` `liveness()`, `started_as()` (procStart), `pid_runs()` | `VisOf`, `Runs`, `ProcStartCheck` |
| `terminal/sync.rs` `scan()` -> `sync_session` -> `mapped` / `adopt` (fork: lane session := terminal's) and `update_state` (`stale` + `forget_loaded` when seen live; skipped while `taking`; `set_writer`) | `Scan` |
| `agent/bot/session.rs` `forget_loaded()` ("a turn running there is left alone"), `hub/actors.rs` `Cmd::ForgetLoaded` | `Forgets` |
| DESIGN `docs/kith-bot-guests.md` 5.8 step 5 and 6.2 (`heldByOtherWriter`, `liveWriter = "bot"`) | `BotGate_` (not in code: `BotEnabled`) |

One step in the code is one action here. A check followed later by the act it guards is two actions
(`AppGate` then `Enqueue` then `HostStart`; `TakeRecheck` then `TakeSignal`; `TermResolve` then `TermUp`), because
another writer can act between them.

## Bounds and assumptions

- One thread, two terminal runs (`t1`, `t2`, each runs once: fresh, launching, idle, busy, dying, gone), at most 2
  sends (`MaxSends`), one fork of the session id. Start state: an app thread the host knows no terminal for (also
  threads from before #128, which have no `data.thread`), or a thread born in a live terminal.
- Time is not modeled: the 3 s scan interval, claude's start time and the 5 s exit wait are "any order". So a
  finding is about an order that is possible, and the window can be milliseconds or seconds (stated per finding).
- Assumed true and not checked: the transcript exists with a user message (`create_thread`); the registry file is
  written by the hook only for listable runs (`listable()`); import contents and cursors are right (this model is
  about who writes, not what is imported); routines, group rooms and other lanes of the bot are not thread lanes.
- The kernel's `live_pid` has no procStart check; a reused pid there only makes `--resume` refuse (fail safe), so it
  is not modeled.
- Liveness (every send eventually runs or is refused) is not checked: it needs fairness assumptions that the code
  does not state.
- A pass covers this model at these bounds. It says nothing about the host's import, memory, or other agents.
- Bot guests: `kith ask --thread` is NOT wired to threads in code. `BotEnabled`/`BotGate` model the design
  (`docs/kith-bot-guests.md`); a gap there is "not built yet", not a bug. When it is wired, re-sync: map the real
  gate onto `BotGate_` and make the `BotRefusedWhileHeld` rows describe the code.

## Findings at the sync commit (the code breaks these; the rows in checks.tsv say `fail` on purpose)

All come from the code as it is; none was "fixed" in the model. `run.sh --show code <PROPERTY>` prints each.

1. **Check, then act, with no claim (`ResumeNeverWhileSendPending`, `SendNeverWhileTerminalClaims`, `ResumeNeverWhileOtherTerminal`, `OneWriter`).**
   (a) The app's `send` passes `before_send_blocking` and is queued; `kith <agent> --resume` runs `resolve`: `hostBusy`
   is false because `working_lanes` counts only a RUNNING turn, `live_pid` is false; claude starts; the queued
   turn then starts (`start_turn` does not look at the terminal) while the terminal is open. Window: the queue
   delay (usually ms, longer if a turn is ahead).
   (b) `resolve` passes, claude takes seconds to start and write its session file; a send passes `before_send`
   (terminal not live yet) and its turn runs; claude comes up in the same session.
   (c) Two terminals `--resume` the same session: neither has written the registry file (SessionStart hook) yet,
   so `live_pid` is false for both.
   Harm: two writers on one session. Nothing in the host remembers that a resume is under way.
2. **The send gate trusts a copy that appears on the next scan (`SendNeverWhileTerminalClaims`, variant `code-instant`).**
   `before_send_blocking` returns Ok when `terminal.info.<thread>` is missing. For an app thread a terminal just
   resumed, that key is written by `scan` (every 3 s). A send in that window runs next to the terminal. Also, the
   gate reads `info` (the last scanned registry), not the registry file.
3. **SIGTERM after the recheck (`TakeoverOnlyWhenIdle`, `NoForeignSignal`).** `take_over_inner` re-checks "Idle",
   then calls `terminate`. If the user submits a prompt between the two (or the terminal exits and its pid is
   reused), the signal lands on a busy terminal or an unrelated process. Window: microseconds; `pidfd`-style
   atomicity is not available portably. Low likelihood, real harm if hit.
4. **The lane session follows the terminal's fork only on the next scan (`ContinuesLastSession`).** A terminal
   resumes, forks the session (new id), is closed, and a send is accepted before a scan has run `adopt`: the host
   resumes the old session. Window: the terminal must live and exit within one scan.
5. **A terminal that ran and exited between two scans never marks the cache stale (`CacheNeverStale`, variant `whatif-no-import-forget`).**
   `update_state` sets `stale` + `forget_loaded` only when it sees the terminal live; `import` of new lines does
   not. The host's cached session then misses the terminal's turn. Window: one scan interval; the terminal's whole
   turn must fit inside it.
6. **Design, not code: the bot gate (`BotRefusedWhileHeld`).** Both a gate that reads `liveWriter` (stale until the
   next scan) and one that reuses `before_send` fail the same way as 1 and 2. The bot path needs the same claim as
   the fix below. Not built yet.

What fixes them (the `whatif-fixes` variant passes every property): `resolveThread` records a claim in the same
step that it checks busy, counting queued sends; sends and turn starts wait while a claim or live terminal
exists; the gate reads the registry file; the turn start re-reads the registry's session; the signal is tied to
the checked process; `import` of terminal lines also forgets the cache. These are suggestions for the owners of the
code, not changes made here.

## How we know it can fail

Each property fails on a broken variant (rows `broken-*` in `checks.tsv`; read the counterexample with
`run.sh --show <variant> <property>`):

| Variant | Removed | Fails |
|---|---|---|
| `broken-no-send-gate` | the live check in `before_send_blocking` | `SendRefusedWhenHostSeesTerminal` |
| `broken-no-taking-block` | the `taking` check | `SendRefusedWhenHostSeesTerminal` |
| `broken-resume-ignores-host` | `hostBusy` die in `resolve` | `ResumeRefusedWhileTurnRuns` |
| `broken-resume-ignores-open` | `live_pid` die in `resolve` | `ResumeRefusedWhileOpen` |
| `broken-takeover-busy` | Busy refusal and recheck in `take_over_inner` | `TakeoverOnlyWhenIdle` |
| `broken-no-procstart` | procStart check in `started_as` (with atomic signal) | `NoForeignSignal` |
| `broken-no-forget` | `forget_loaded` (with the other fixes) | `CacheNeverStale` |
| `code` (as is) | nothing: the findings above | `OneWriter` and the strict rows |

Also proved once on the real code (scratch edits, not committed): removing the `hostBusy` die in
`kernel/bin/kith-sessions` and the live check in `terminal/sync.rs` `before_send_blocking` each made `drift.sh`
list the file; after setting the matching switch in `base.consts` (`ResumeChecksHostBusy`, `SendChecksLive` = FALSE),
`run.sh` failed the rows that guard it; both were then dropped.

## When you change covered code

1. `verification/threads/drift.sh`. Nothing listed: no work. Listed files: read each diff and the commit messages
   (`git log --oneline <SYNC>..HEAD -- <file>`), including code that moved to other files and new code that writes
   the guarded state (the registry, `taking`, the lane session, `liveWriter`, `Cmd::Send`).
2. Decide per change: no effect on the model; the model no longer matches (a step split in two, a check moved or
   removed, a new path to start a turn or a terminal); or the promise changed on purpose (cite the doc comment,
   test or commit). Update `Threads.tla` and `base.consts` from the code, not from what makes a result pass. Keep
   one step in code = one action; cite the function in the comment above the action.
3. `verification/threads/run.sh`. A row that differs is either drift (the model is wrong: replay the TLC
   counterexample step by step against the code; if a step cannot happen, fix the model and say what was wrong) or
   a bug (every step can happen: report it as a finding with the steps in the code's words and the harm; do not
   weaken the property or the model, and do not change product code unless asked). A finding that the code now
   fixes turns its row from `fail` to `pass`: change `checks.tsv` only with that evidence, and move the finding out
   of the list above.
4. A pass on updated code can have lost the ability to fail: break the new check (remove it or reorder the step)
   in a scratch edit and see `run.sh` fail; then drop the edit. Add a `broken-*` variant for a new check.
5. New writer or state: add the property, a `broken-*` variant that fails it, and a row each.
6. Only then set `SYNC` in `drift.sh` and the sync commit above to the commit you checked.

Not a bug: a counterexample that needs a step the code cannot take (for example a state the scan or hook can
never produce). That is a modeling error: fix the model.

For upkeep after merges that skipped this skill, follow `/maintain-formal-verification-skill` (pstack): find the
commits that touched covered code, update the model from the code, rerun, report each failure as drift or bug.

## Map of the folder

- `Threads.tla`: the model (actions cite code; properties at the end).
- `base.consts`: the switches for the code as it is. `variants/*.set`: overrides per variant (what-ifs, broken variants).
- `checks.tsv`: the table `run.sh` enforces. `run.sh`: pinned tools and the table. `drift.sh`: sync commit and covered files.
