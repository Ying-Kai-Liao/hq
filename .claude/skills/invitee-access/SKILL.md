---
name: invitee-access
description: Property tests that an invited person (and later a bot guest) never gets more than they were granted. Use when a change touches serve/host/src/api/roles.rs (guard, member_may, MEMBER_METHODS, shape, event_for, shape_bot, hello_for, own_bot, approves_own, may_use, granted_agents), a router method in serve/host/src/api/ (a new method must stay off the member list unless justified), dispatch/member_call in api/mod.rs, people/proveInvite, event fan-out in api/events.rs, or kernel/bin/kith-auth (resolve, may, person --rm, member, bot, bots-cap), and later BOT_METHODS or the bot principal.
---

# Invitee access never exceeds the grant

The costliest bug in Kith is an invited person reaching an agent, chat, folder, project, event or permission prompt they were not granted. Unit tests check hand-picked cases; these check generated ones, on the real code.

Tool: property tests with generated inputs. Rust has no cheap verifier that runs async/subprocess code (Kani cannot), so the real `roles` functions run against a real store and a stand-in `kith-auth` (proptest, pinned `=1.12.0`, dev-dependency only). `kith-auth` itself is checked with hypothesis (pinned `6.169.2`, through `uv run --with`, nothing global).

## Properties (what, and the harm if it breaks)

Host, `serve/host/src/api/roles_props.rs`:

1. `guard` lets a proven person through only for a method on `MEMBER_METHODS`; for a method that names a chat, that chat is theirs, not deleted, and kith-auth allows its agent right now. Harm: someone reads or drives another person's or the owner's chat.
2. An unproven device may only call `proveInvite`. Harm: an invite link alone opens the host.
3. `respondPermission` passes only for a card of kind permission, raised by that chat, and only when kith-auth says preset `member`. Harm: a guest approves their own agent's dangerous action; a prompt of another chat is answered.
4. `send` passes with no folder or clear, and a project only if it is in the person's shared projects (checked with the handler's own `Change::from_args`). Harm: a guest picks a folder on the owner's Mac.
5. The same call after the grant is removed is refused (kith-auth is asked every call). Harm: a revoked person keeps access.
6. `event_for`: a person gets only `bot`/`entry`/`resync` events of their own chats whose agent is still in their person row, never usage, screens or cloud events, and no `cwd`/`command`/`folder`; the owner sees an invitee's chat only as permission prompts. Harm: leaks of other people's chats and of the Mac.
7. `shape` (hello, projects, history, thread, kithInfo), `shape_bot`, `hello_for` leave no folder, cwd, command, path or error text (also on a real `bot_json`). Harm: file paths of the Mac shown to a guest.
8. kith-auth fails closed: `may_use` is true only for `allowed: true` and not owner; failure, empty or garbage output, `"true"` or `1` for allowed, truncated JSON are all a no; `approves_own` is true only for preset exactly `member`; `granted_agents` never lists an agent kith-auth denies. Harm: a broken kith-auth opens every door.
9. Calls that must pass do pass (`guard_lets_a_granted_member_use_their_own_chat`), so "refuse everything" cannot satisfy the rest.

kith-auth, `kernel/tests/kith-auth-props.py` (generated command sequences on a throwaway auth.json):

10. A person is allowed only through their own row or the `*` row; an unknown id never.
11. A bot is allowed only with a row of its own (the `*` row never reaches it) and while its owner is allowed right now; it runs as `guest`; for an invitee's bot, deny is a superset of the owner's, helpers are a subset, budget equals the owner's; the owner's bots take `owner_bots_budget` when set.
12. Removing a person removes their bots and every membership; they and their bots fail `resolve` at the next call. Taking an agent from a person takes it from their bots.
13. A refused `bots-cap` leaves the cap as it was.

## Coverage record

Sync commit: `950ad5c5` (origin/main when written). If `git diff 950ad5c5 -- <file>` shows changes in a covered file, the check needs another look before you trust a pass.

| File | Functions | Properties |
|---|---|---|
| serve/host/src/api/roles.rs | `guard`, `member_may`, `MEMBER_METHODS`, `UNPROVEN_METHODS` | 1, 2, 3, 4, 5, 9 |
| | `own_bot`, `may_use`, `resolve` (private), `approves_own`, `granted_agents` | 1, 3, 5, 8 |
| | `event_for`, `bot_person` | 6 |
| | `shape`, `shape_bot`, `hello_for` | 7 |
| serve/host/src/agent/folder.rs | `Change::from_args` (used as the oracle for send) | 4 |
| serve/host/src/api/mod.rs | `member_call` (guard before route) | read, not run: see not covered |
| kernel/bin/kith-auth | `resolve`, `resolve_bot`, `may`, `bot_may`, `bot_row`, `cmd_person --rm`, `cmd_member`, `cmd_bot`, `cmd_bots_cap` | 10-13 |

## Run

- Host, only these tests: `cd serve/host && cargo test --bin kith roles_props` (about 10 s of run time; `PROPTEST_CASES=1000` for more). They run in the normal host `cargo test` in CI. The Mac is often loaded: prefer CI for the first compile.
- kith-auth: `kernel/tests/kith-auth-props` (seconds; `PROPS_EXAMPLES=3000` for more). Needs `uv`. CI runs it as the "Auth property check" step of the kernel job, right after "Auth check".

## Bounds and assumptions

- The stand-in kith-auth (`$KITH_FAKE/<person>__<agent>` files, a shell script) answers `resolve AGENT --person P` only; a missing file is a failure (exit 1, nothing printed). It assumes the real kith-auth prints its answer on stdout as one JSON object; the host ignores the exit status, so a failing process that printed `allowed: true` is not modelled.
- Seam: `account::TEST_BIN`, `hq::TEST_ENV` and `ONE_AT_A_TIME` (all `cfg(test)`); no product code was changed.
- Two people, two agents, four chats plus one the store never had, up to three entries, two projects; method names from the router walk (copied from `roles_tests::router_methods`), `MEMBER_METHODS` and random text. 96 cases per property by default.
- Events are checked by their top-level fields; a nested secret in an `entry` payload is content, not covered. `resync` passes unchanged by design.
- The person row (agents, projects) lives in the host store and is judged by `event_for`; kith-auth is judged by `guard`. The harness generates them independently, so a drift between them is allowed by the generator and only the code decides.
- Python side: two invitees, two bots, two agents, sequences up to ~19 commands through `kith-auth main()` in process; commands the CLI refuses are skipped (their effect is checked only where stated).

## Real bug or harness error

A failure prints a shrunk case. Reproduce it by hand: write the person and bot rows as the scenario says, put the answer files in a temp dir, call the function. If the code lets the call through while the scenario says it should not, it is a bug: do not weaken the property; report it with the steps. If the scenario cannot happen in the product (for example a kith-auth answer it never prints), fix the generator and say why in this file. A panic in `World::new` or a script error is the harness.

## Updating for an intended change

- A new `MEMBER_METHODS` entry: add it with a reason in `roles.rs`, then say here which guard branch covers it; if it names a chat by a new field, teach `by_entry`/`body` in `roles_props.rs` that field, or property 1 passes by never exercising it.
- A new event type, shaped answer or bot-guest role (`BOT_METHODS`, bot principal): add a generator and a property, then a broken variant that fails it.
- kith-auth rules: change the Python oracle in the same commit as the rule.
- Move the sync commit only after you confirm the properties still describe the code at the new commit (re-read the covered functions, run both commands, and for each new branch see a broken variant fail). `/maintain-formal-verification-skill` (pstack) brings this in line after changes that did not recheck it.

## Broken variants seen failing

See the table at the end (filled from CI runs of one deliberate break per property).

## Not yet covered

- Bot guests on the host (BOT_METHODS, bot principal, revoke cascade in `api/botguests.rs`): in progress elsewhere; add when merged.
- That owner devices and `Local` never reach `guard` (`dispatch` branches on `principal`): covered by `a_caller_is_the_owner_or_a_person` in `roles_tests.rs`, not generated.
- The handlers behind allowed methods (`upload`, `readUpload`, `react`, `history` payloads) beyond the shaping in `roles.rs`.
- Cloud invite token hashing (serve/cloud, TypeScript), memory audiences (kith-context, design stage), one-writer threads (kith-formal-verify-threads).
