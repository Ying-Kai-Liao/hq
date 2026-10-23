# Contributing

## CI and merging

Pull requests run a fast tier of checks (lint, unit tests, typecheck). The slow ones (macOS builds, e2e tests) run in the Mergify merge queue; add the `ci:full` label to run them on the PR itself. Queue a PR once `ci` is green on it:

```
gh pr edit <n> --add-label queue
```

Mergify batches up to 8 queued PRs on top of the latest main, runs the full suite on the batch, and merges it with merge commits. If a batch fails it is split to find the culprit. There are no intermediate or integration branches.

Never `gh pr merge` directly: that skips the heavy tier. Don't rebase or merge main into a branch just to be up to date; only to resolve a real conflict. Details: [docs/ci.md](docs/ci.md).
