#!/usr/bin/env python3
"""One stand-in for hq, hq-auth and hq-live in the channels' tests: it acts as whichever name it is called by.

The test makes symlinks <rig>/bin/hq, hq-auth and hq-live to this file; the rig's files are in <rig>/stub/:
  people.json   {"<platform>:<uid>": {person, owner, was}}      what `hq-auth who` says
  access.json   {"<person>": {"owner": bool, "agents": [..]}}   what `hq-auth resolve` says
  codes.json    {"<CODE>": "<person>"}                          what `hq-auth link` accepts
  granted.json  {"<platform>": ["<profile>", ..]}               what `hq-auth granted` lists
  secrets.json  {"<profile>": {"<VAR>": "<value>"}}             what `hq-auth get` prints
  live.json     {"running": bool}                               whether `hq-live send` finds a session
  calls.jsonl   every call, one JSON object per line

`hq <agent> <task>` answers {"result": "echo:<task>", "session_id": "sess-<agent>-<n>"}. A task that starts with
SLOW sleeps until killed, SLEEP for 1.5 s; one containing SEND leaves two posts in HQ_BRIDGE_OUTBOX; FAIL exits 1;
BIGCTX reports a context 60% full, BGHOLD leaves a process holding its output open.
"""
import json
import os
import sys
import time

me = os.path.basename(sys.argv[0])
root = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))
stub = os.path.join(root, "stub")
args = sys.argv[1:]


def load(name, default):
    try:
        with open(os.path.join(stub, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, value):
    with open(os.path.join(stub, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(value, f)


def log(record):
    with open(os.path.join(stub, "calls.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def fail(text):
    print(text, file=sys.stderr)
    sys.exit(1)


if me == "hq-auth":
    cmd = args[0] if args else ""
    if cmd == "who":
        print(json.dumps(load("people", {}).get(f"{args[1]}:{args[2]}", {"person": None, "owner": False, "was": []})))
    elif cmd == "resolve":
        agent, person = args[1], args[args.index("--person") + 1]
        entry = load("access", {}).get(person)
        if entry is None:
            print(json.dumps({"allowed": False, "why": f"{person} is not in hq", "owner": False}))
        else:
            owner = bool(entry.get("owner"))
            allowed = owner or agent in entry.get("agents", [])
            print(json.dumps({"allowed": allowed, "why": f"{person} may not use {agent}", "owner": owner}))
    elif cmd == "link":
        platform, uid, code = args[1:4]
        person = load("codes", {}).get(code)
        if person is None:
            fail("hq-auth: that code did not work")
        people = load("people", {})
        people[f"{platform}:{uid}"] = {"person": person, "owner": False, "was": []}
        save("people", people)
        print(person)
    elif cmd == "granted":
        granted = load("granted", {})
        if granted.get("_fail"):
            fail("hq-auth: the auth file is locked")
        print("\n".join(granted.get(args[-1], [])))
    elif cmd == "get":
        profile, var = args[args.index("--profile") + 1], args[-1]
        value = load("secrets", {}).get(profile, {}).get(var)
        if value is None:
            fail(f"hq-auth: {var} is not set")
        print(value)
    else:
        fail("hq-auth: unknown command")
elif me == "hq-live":
    log({"tool": "hq-live", "args": args})
    if not load("live", {"running": True}).get("running"):
        fail("no live session for that agent")
elif me == "hq":
    agent, task = args[0], args[1]
    env = os.environ
    log({
        "tool": "hq", "agent": agent, "task": task,
        "resume": env.get("HQ_RESUME"), "person": env.get("HQ_PERSON"), "via": env.get("HQ_VIA"),
        "output": env.get("HQ_OUTPUT"), "extra": env.get("FAKE_EXTRA"), "mode": env.get("HQ_PERMISSION_MODE"),
        "outbox": bool(env.get("HQ_BRIDGE_OUTBOX")),
        "withheld": sorted(k for k in env if k.startswith(("JEV_", "TELEGRAM_", "SLACK_", "DISCORD_", "HQ_DISCORD_"))
                           or k in ("HQ_AGENT",)),
        "cwd": os.getcwd(),
    })
    counts = load("sessions", {})
    counts[agent] = counts.get(agent, 0) + 1
    save("sessions", counts)
    if "BGHOLD" in task:
        # A background process that keeps stdout open after the agent is done.
        import subprocess
        bg = subprocess.Popen(["sleep", "60"], stdin=subprocess.DEVNULL)
        with open(os.path.join(stub, "bg.pid"), "w", encoding="utf-8") as f:
            f.write(str(bg.pid))
    if "SEND" in task:
        outbox = env["HQ_BRIDGE_OUTBOX"]
        for item in ({"as": "image", "text": "tool says hi"},
                     {"as": "image", "files": ["/tmp/pic.png"], "caption": "a picture"}):
            name = os.path.join(outbox, f"{time.time_ns()}.json")
            with open(name + ".tmp", "w", encoding="utf-8") as f:
                json.dump(item, f)
            os.rename(name + ".tmp", name)
            time.sleep(0.01)
    if task.startswith("SLOW"):
        time.sleep(60)
    if task.startswith("SLEEP"):
        time.sleep(1.5)
    if "FAIL" in task:
        fail("boom")
    out = {"result": "echo:" + task, "session_id": f"sess-{agent}-{counts[agent]}", "is_error": False}
    if "BIGCTX" in task:
        out["usage"] = {"iterations": [{"input_tokens": 600}]}
        out["modelUsage"] = {"m": {"contextWindow": 1000, "inputTokens": 600}}
    print(json.dumps(out))
