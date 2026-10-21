#!/usr/bin/env python3
"""A stand-in for the `hq` CLI: `ls --json` lists one agent, `<agent> --launch-json` describes how to start it.

STUB_HQ_HOME is the agent's folder. Every call is appended to calls.jsonl there (arguments, HQ_VIA, working
directory). A file named `fail` in that folder makes --launch-json fail with its text on stderr.
"""
import json
import os
import sys

home = os.environ["STUB_HQ_HOME"]
args = sys.argv[1:]
with open(os.path.join(home, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"args": args, "via": os.environ.get("HQ_VIA"), "cwd": os.getcwd()}) + "\n")

if args == ["ls", "--json"]:
    print(json.dumps([{"name": "house", "description": "Keeps the house", "home": home, "model": None,
                       "effort": None, "harness": "claude"}]))
elif args[:2] == ["house", "--launch-json"]:
    fail = os.path.join(home, "fail")
    if os.path.exists(fail):
        print(open(fail, encoding="utf-8").read(), file=sys.stderr)
        sys.exit(1)
    model = args[args.index("-m") + 1] if "-m" in args else "haiku"
    print(json.dumps({
        "version": 1, "agent": "house", "agent_version": "v1", "harness": "claude", "cwd": home,
        "env": {"HQ_AGENT": "house", "HQ_VIA": os.environ.get("HQ_VIA", ""), "HQ_MODEL": model},
        "system_prompt": "You are house, the household keeper.",
        "settings": {"hooks": {"SessionStart": []}},
        "mcp_servers": {"pantry": {"command": "pantry-mcp", "args": [], "env": {}}},
        "add_dirs": [home + "/data"], "allowed_tools": ["Read"], "disable_slash_commands": True,
        "model": model, "effort": None, "permission_mode": "default", "cost_tag": {}, "claude_args": [],
    }))
else:
    print("unknown agent", file=sys.stderr)
    sys.exit(2)
