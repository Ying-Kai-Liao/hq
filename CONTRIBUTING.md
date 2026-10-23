# Contributing

## CI and merging

Pull requests run a fast tier of checks (lint, unit tests, typecheck), shown as `ci-fast`. The slow ones (macOS builds, e2e tests) run on the PR once auto-merge is on, or earlier with the `ci:full` label; those full runs report the required check `ci`. Merge with:

```
gh pr merge <n> --auto --merge
```

Merging runs the full suite on the PR and GitHub merges when `ci` is green. There is no batching and no re-test against the latest main, so don't rebase or merge main into a branch just to be up to date; only to resolve a real conflict. Details: [docs/ci.md](docs/ci.md).
