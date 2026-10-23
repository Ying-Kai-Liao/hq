# Contributing

## CI and merging

Pull requests run a fast tier of checks (lint, unit tests, typecheck). The slow ones (macOS builds, e2e tests) run when the PR enters the merge queue; add the `ci:full` label to run them on the PR itself. Merge with:

```
gh pr merge <n> --auto --merge
```

Don't rebase or merge main into a branch just to be up to date; only to resolve a real conflict. Details: [docs/ci.md](docs/ci.md).
