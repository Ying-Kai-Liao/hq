#!/usr/bin/env python3
"""A stand-in for the `kith` CLI: `ls --json` lists one agent, `<agent> --launch-json` describes how to start it,
`project ls --json` lists the projects in `projects.json` (`{"projects": [...]}`) and `project add <id> <path>` adds one.

STUB_HQ_HOME is the agent's folder. Every call is appended to calls.jsonl there (arguments, KITH_VIA, working
directory). A file named `fail` in that folder makes --launch-json fail with its text on stderr.
"""
import json
import os
import sys

home = os.environ["STUB_HQ_HOME"]
args = sys.argv[1:]
with open(os.path.join(home, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"args": args, "via": os.environ.get("KITH_VIA") or os.environ.get("HQ_VIA"), "cwd": os.getcwd()}) + "\n")

if args == ["ls", "--json"]:
    print(json.dumps([{"name": "house", "description": "Keeps the house", "home": home, "model": None,
                       "effort": None, "harness": "claude"}]))
elif args[:2] == ["project", "ls"]:
    path = os.path.join(home, "projects.json")
    print(open(path, encoding="utf-8").read() if os.path.exists(path) else '{"projects": []}')
elif args[:2] == ["project", "add"]:
    path = os.path.join(home, "projects.json")
    projects = json.load(open(path, encoding="utf-8"))["projects"] if os.path.exists(path) else []
    if any(p["id"] == args[2] for p in projects):
        print(f"project {args[2]} already exists", file=sys.stderr)
        sys.exit(1)
    projects.append({"id": args[2], "paths": [args[3]], "home": args[3], "remotes": [], "parent": None,
                     "memory": None, "exists": True})
    json.dump({"projects": projects}, open(path, "w", encoding="utf-8"))
elif args == ["house", "--info-json"]:
    fail = os.path.join(home, "info_fail")
    if os.path.exists(fail):
        print(open(fail, encoding="utf-8").read(), file=sys.stderr)
        sys.exit(1)
    memory = os.path.join(home, "memory")
    names = sorted(n for n in os.listdir(memory) if os.path.isfile(os.path.join(memory, n))) if os.path.isdir(memory) else []
    files = [{"path": n, "bytes": os.path.getsize(os.path.join(memory, n)), "modified": "2026-10-22T00:00:00Z"} for n in names]
    print(json.dumps({
        "version": 1, "agent": "house", "description": "Keeps the house", "harness": "claude", "model": None,
        "effort": None, "permission_mode": None, "home": home,
        "role": {"path": home + "/role", "intro": "Keeps the house.", "sections": [{"title": "Not yours", "text": "Money."}]},
        "package": {"version": None, "remote": None, "dirty": False, "unpushed": 0, "pinned": None},
        "skills": [], "tools": [], "mcp_servers": [], "plugins": [], "projects": [], "schedules": [], "cost": None,
        "memory": {"dir": memory, "files": files, "total_bytes": sum(f["bytes"] for f in files)}, "errors": {},
        "future_key": True,
    }))
elif args[:2] == ["memory", "search"]:
    if os.path.exists(os.path.join(home, "search_fail")):
        print("search broke", file=sys.stderr)
        sys.exit(1)
    n = int(args[args.index("-n") + 1])
    hit = {"path": "notes.md", "line": 1, "agent": args[args.index("--agent") + 1], "snippet": f"{args[2]} agent={args[args.index('--agent') + 1]}"}
    print(json.dumps({"hits": ([hit] * 3)[:n]}))
elif args == ["cost", "record"]:
    # A dream's cost row: the JSON on stdin and who it is for.
    with open(os.path.join(home, "cost.jsonl"), "a", encoding="utf-8") as cost:
        cost.write(json.dumps({"row": json.load(sys.stdin), "agent": os.environ.get("KITH_AGENT"),
                               "via": os.environ.get("KITH_VIA")}) + "\n")
elif args == ["house", "--backups-json"]:
    # `chain.json` is the chain after the agent's own login; without one the agent has no backups.
    path = os.path.join(home, "chain.json")
    chain = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    primary = {"id": "claude", "harness": "claude", "account": None, "kind": "primary", "ready": True}
    print(json.dumps({"version": 1, "agent": "house", "chain": [primary] + chain}))
elif args[:2] == ["house", "--launch-json"]:
    fail = os.path.join(home, "fail")
    if os.path.exists(fail):
        print(open(fail, encoding="utf-8").read(), file=sys.stderr)
        sys.exit(1)
    backup = args[args.index("--backup") + 1] if "--backup" in args else None
    # A file named `launch_fail_<entry>` (":" as "_") makes hq refuse that entry, as it does one it can't run.
    if backup and os.path.exists(os.path.join(home, "launch_fail_" + backup.replace(":", "_"))):
        print(f"{backup} is not logged in", file=sys.stderr)
        sys.exit(4)
    harness = "codex" if backup and backup.split(":")[0] == "codex" else "claude"
    account = backup.split(":")[1] if backup and ":" in backup else None
    model = args[args.index("-m") + 1] if "-m" in args else "haiku"
    print(json.dumps({
        "version": 1, "agent": "house", "agent_version": "v1", "harness": harness, "cwd": home,
        "backup": backup, "provider": harness, "account": account,
        "env": {"KITH_AGENT": "house", "HQ_AGENT": "house", "KITH_VIA": os.environ.get("KITH_VIA", ""), "HQ_VIA": os.environ.get("KITH_VIA", ""), "KITH_MODEL": model, "HQ_MODEL": model,
                "KITH_PROVIDER": harness, "KITH_ACCOUNT": account or "", "KITH_BACKUP": backup or ""},
        "system_prompt": "You are house, the household keeper.",
        "settings": {"hooks": {"SessionStart": []}},
        "mcp_servers": {"pantry": {"command": "pantry-mcp", "args": [], "env": {}}},
        "add_dirs": [home + "/data"], "allowed_tools": ["Read"], "disable_slash_commands": True,
        "model": model, "effort": None, "permission_mode": "default", "cost_tag": {}, "claude_args": [],
    }))
else:
    print("unknown agent", file=sys.stderr)
    sys.exit(2)
