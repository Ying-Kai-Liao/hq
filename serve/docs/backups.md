# Backups in the apps (`backups`, `backupsSet`)

The host's view of the backup chain (the order kith moves a bot's turns to when its own account runs out of usage; the
failover itself is `agent/backups.rs`). Code: `host/src/api/backups.rs`. A paired phone may call both (Control scope).

## `backups {}`

```json
{
  "global": ["codex", "claude:work"],
  "agents": { "house": ["claude:work"] },
  "entries": [
    { "id": "codex", "harness": "codex", "account": null, "kind": "subscription",
      "ready": false, "why": "not logged in", "fix": "codex login",
      "outUntil": null, "reason": null }
  ]
}
```

- `global`: entry ids in order. `agents`: only agents with an order of their own (an agent not listed follows `global`;
  `[]` is an own, empty order).
- `entries`: every entry in an order, plus extra accounts on this Mac that are in none (what the app offers to add).
  `ready` / `why` / `fix` come from kith (`kith backup list --json`, `kith account list --json`); `fix` is the one
  command to run in the terminal. `outUntil` is epoch milliseconds while the entry is out of usage (from `backups.json`);
  `reason` is `rate_limit` or `usage_95`.
- No token, environment value or account folder is ever returned.
- kith missing or failing is an error (400) with kith's text.

## `backupsSet { agent: string|null, chain: [ids]|null }`

Replaces a whole order in one `kith account backup set` write: `agent` null is the global order. `chain: null` with an
agent drops its own order (`kith account backup reset --agent A`). Writes are serialized, the last to arrive wins, and
the answer is the same as `backups`. Ids are checked (`claude`, `claude:work`, `claude-api:main`, `codex`…) before kith
is run, and kith checks them again.
