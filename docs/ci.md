# CI

One workflow, `.github/workflows/ci.yml`. The single required check is the umbrella job `ci`: it passes when every job it needs passed or was skipped by a path filter, and fails on any failure or cancellation. Every new job must be added to its `needs` list.

## Jobs

| Job | Runner | What |
| --- | --- | --- |
| `changes` | linux | Path filters (below). |
| `host` | linux | `cargo fmt --check` and clippy on the whole host workspace. |
| `host-build` | linux | Builds all host test binaries once as a cargo-nextest archive (uploaded as an artifact). |
| `host-test` (unit, e2e-1..3) | linux | Runs the archive: unit tests, then `tests/*.rs` split into three `--partition` shards. Config: `serve/host/.config/nextest.toml`, profile `ci`. |
| `host-crates` | linux | Tests and doctests of guest, tts, wire and memory (nextest does not run doctests). |
| `guest-linux` | linux x86_64 and arm64 | Static kith-guest build, installer and smoke test. |
| `cloud`, `relay`, `licenses`, `kernel`, `thread-writers` | linux | As named. |
| `desktop-js`, `desktop-relay-e2e` | linux | Desktop typecheck and unit tests; the relay e2e against a real kith-serve. |
| `ios`, `desktop` | macos-26 | Only what needs macOS: the iOS build and the unsigned Mac app build. |

No paid, larger or self-hosted runners. Rust caches come from Swatinem/rust-cache and are saved only on main (PR and queue refs cannot share caches and would evict main's). npm and SwiftPM caches are kept per job.

## Path filters

Filtering happens in `changes`, not in `on.paths`, so `ci` always reports. A docs-only change runs no heavy job. `host_core` (everything the host binary builds from) is narrower than `host`: a change only under `serve/host/crates/guest` or `crates/tts` skips `host-build` and `host-test`, because nothing in the host depends on them; `host-crates` still runs.

On `merge_group` the filters are skipped and every output is true: queue batches run the full suite. Pushes to main and PRs use the filters as before.

## Merging

This repo uses merge commits and a merge queue:

```
gh pr merge <n> --auto --merge
```

The PR enters the queue once `ci` is green on it, and GitHub tests it (batched with others, up to about 8 per batch) against the latest main using the same workflow, in full. If a batch fails GitHub splits it and re-tests, so the failing PR is dropped on its own. There are no intermediate or integration branches; batching in the queue replaces them.

Never rebase or merge main into a branch just to be up to date. Do that only to resolve a real conflict.

## Concurrency

A PR gets one group per ref, so a re-push cancels its older run. Pushes to main and merge-queue runs are keyed by sha and run id and are never cancelled.
