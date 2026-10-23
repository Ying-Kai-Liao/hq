# CI

One workflow, `.github/workflows/ci.yml`. The single required check is the umbrella job `ci`: it passes when every job it needs passed or was skipped by a path filter, and fails on any failure or cancellation. Every new job must be added to its `needs` list.

## Jobs

| Job | Runner | What |
| --- | --- | --- |
| `changes` | linux | Path filters (below). |
| `host` | linux | `cargo fmt --check` and clippy on the whole host workspace. |
| `host-build` | linux | Builds all host test binaries once as a cargo-nextest archive (uploaded as an artifact). |
| `host-test` | linux | Runs the archive's unit tests. Config: `serve/host/.config/nextest.toml`, profile `ci`. |
| `host-e2e` (1..3) | linux | The archive's `tests/*.rs` integration tests, in three `--partition` shards. Heavy tier. |
| `host-crates` | linux | Tests and doctests of guest, tts, wire and memory (nextest does not run doctests). |
| `guest-linux` (heavy) | linux x86_64 and arm64 | Static kith-guest build, installer and smoke test. |
| `cloud`, `relay`, `licenses`, `kernel`, `thread-writers` | linux | As named. |
| `desktop-js`, `desktop-relay-e2e` (heavy) | linux | Desktop typecheck and unit tests; the relay e2e against a real kith-serve. |
| `ios`, `desktop` (heavy) | macos-26 | Only what needs macOS: the iOS build and the unsigned Mac app build. |

No paid, larger or self-hosted runners. Rust caches come from Swatinem/rust-cache and are saved only on main (PR refs cannot share caches and would evict main's). npm and SwiftPM caches are kept per job.

## Tiers

- Cheap tier, every pull request: fmt, clippy, host unit tests, kernel, cloud and relay (typecheck, vitest), licenses, thread-writers, desktop typecheck and tests. All path-filtered.
- Heavy tier: the macOS builds (`ios`, `desktop`), every e2e (`host-e2e`, `desktop-relay-e2e`, cloud's bot guests e2e step) and `guest-linux`. They run on push to main, workflow_dispatch and merge_group, never skipped there.
- A pull request gets the heavy tier too when it carries the `ci:full` label (add it with `gh pr edit <n> --add-label ci:full`) or has auto-merge enabled (`gh pr merge <n> --auto --merge`). Once auto-merge is on, every later run on the PR is heavy. A draft pull request gets the cheap tier only, even with the label; mark it ready to run the heavy tier.

The umbrella job is named `ci` only on full runs and `ci-fast` on cheap pull request runs. Branch protection requires `ci`, so a cheap pass never satisfies it: the required check stays pending until a full run reports `ci`. Jobs skipped by the filters count as passed.

## Path filters

Filtering happens in `changes`, not in `on.paths`, so `ci` always reports. A docs-only change runs no heavy job. `host_core` (everything the host binary builds from) is narrower than `host`: a change only under `serve/host/crates/guest` or `crates/tts` skips `host-build` and `host-test`, because nothing in the host depends on them; `host-crates` still runs.

On `merge_group` the filters are skipped and every output is true (the trigger is kept for a possible org-owned repo; it never fires here). Pushes to main and PRs use the filters.

## Merging

This repo uses merge commits and auto-merge:

```
gh pr merge <n> --auto --merge
```

Enabling auto-merge starts a full (heavy) run on the PR, which reports `ci`; GitHub merges when `ci` is green. There is no batching and no re-test against the latest main (strict status checks are off). A merge queue would need an org-owned repo, which is why the `merge_group` trigger is kept.

A PR whose head already has a green cheap-tier `ci` from before this change needs a new push or a re-run before `--auto` can be trusted.

Never rebase or merge main into a branch just to be up to date. Do that only to resolve a real conflict.

## Concurrency

A PR gets one group per ref, so a re-push cancels its older run. Pushes to main, workflow_dispatch and merge_group runs are keyed by sha and run id and are never cancelled.
