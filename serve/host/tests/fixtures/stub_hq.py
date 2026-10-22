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
elif args[:2] == ["house", "--launch-json"]:
    fail = os.path.join(home, "fail")
    if os.path.exists(fail):
        print(open(fail, encoding="utf-8").read(), file=sys.stderr)
        sys.exit(1)
    model = args[args.index("-m") + 1] if "-m" in args else "haiku"
    print(json.dumps({
        "version": 1, "agent": "house", "agent_version": "v1", "harness": "claude", "cwd": home,
        "env": {"KITH_AGENT": "house", "HQ_AGENT": "house", "KITH_VIA": os.environ.get("KITH_VIA", ""), "HQ_VIA": os.environ.get("KITH_VIA", ""), "KITH_MODEL": model, "HQ_MODEL": model},
        "system_prompt": "You are house, the household keeper.",
        "settings": {"hooks": {"SessionStart": []}},
        "mcp_servers": {"pantry": {"command": "pantry-mcp", "args": [], "env": {}}},
        "add_dirs": [home + "/data"], "allowed_tools": ["Read"], "disable_slash_commands": True,
        "model": model, "effort": None, "permission_mode": "default", "cost_tag": {}, "claude_args": [],
    }))
else:
    print("unknown agent", file=sys.stderr)
    sys.exit(2)
