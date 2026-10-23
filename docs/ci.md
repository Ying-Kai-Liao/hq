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

No paid, larger or self-hosted runners. Rust caches come from Swatinem/rust-cache and are saved only on main (PR and batch refs cannot share caches and would evict main's). npm and SwiftPM caches are kept per job.

## Tiers

- Cheap tier, every pull request: fmt, clippy, host unit tests, kernel, cloud and relay (typecheck, vitest), licenses, thread-writers, desktop typecheck and tests. All path-filtered.
- Heavy tier: the macOS builds (`ios`, `desktop`), every e2e (`host-e2e`, `desktop-relay-e2e`, cloud's bot guests e2e step) and `guest-linux`. They run on Mergify queue batches, push to main and workflow_dispatch, never skipped there.
- A pull request gets the heavy tier too when it carries the `ci:full` label (add it with `gh pr edit <n> --add-label ci:full`). A draft pull request gets the cheap tier only, even with the label: `ci-label.yml` doesn't dispatch the heavy run for a draft. Mark it ready to run the heavy tier. The exception is a Mergify batch: a draft PR from a `mergify/merge-queue/*` branch, which `ci.yml` treats as heavy.

Jobs skipped by the tier count as passed in `ci`, so a green PR means "cheap tier green"; the Mergify queue runs the rest on the batch before anything lands on main.

## Path filters

Filtering happens in `changes`, not in `on.paths`, so `ci` always reports. A docs-only change runs no heavy job. `host_core` (everything the host binary builds from) is narrower than `host`: a change only under `serve/host/crates/guest` or `crates/tts` skips `host-build` and `host-test`, because nothing in the host depends on them; `host-crates` still runs.

The filters apply on pull requests (batch PRs included), on pushes to main and on dispatch. On `merge_group` they are skipped and every output is true; that trigger never fires here (GitHub's merge queue needs an org-owned repo) and is kept for a possible move.

## Merging

This repo uses merge commits and a Mergify merge queue (`.mergify.yml`). Once `ci` is green on the PR, queue it:

```
gh pr edit <n> --add-label queue
```

Mergify batches up to 8 queued PRs (waiting at most 3 minutes for company) on top of the latest main as a draft PR on a `mergify/merge-queue/*` branch, and runs the full suite there; the batch's `ci` is the heavy run. If it passes, the PRs merge with merge commits. If it fails, Mergify splits the batch and re-tests to find the failing PR, which is dropped on its own. There are no intermediate or integration branches. The `queue` label is removed only once a PR merges. A PR that Mergify drops from a failed batch keeps the label, so to queue it again, remove the label and add it back.

Never `gh pr merge` directly: that skips the heavy tier.

Never rebase or merge main into a branch just to be up to date. Do that only to resolve a real conflict.

## Concurrency

A PR gets one group per ref, so a re-push cancels its older run. Pushes to main are keyed by sha and run id and are never cancelled. Mergify batch PRs are pull requests on their own `mergify/merge-queue/*` refs, so each has its own group and batches don't cancel each other. Label events never start `ci.yml`, so adding `queue` creates no run and no skipped `ci` check for Mergify to read. Adding `ci:full` runs the small `ci-label.yml`, which dispatches `ci.yml` on the PR branch (a dispatch run is heavy, ignores draft state, and its `ci` lands on the head sha); a cancelled run skips `ci` instead of reporting a failure.
