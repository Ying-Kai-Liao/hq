"""A scripted stand-in for claude-agent-acp, for an hq agent's chat and its tidying.

It answers like Claude's adapter (`_meta.claudeCode` in `initialize`). A session whose `systemPrompt` starts with the
tidying job gets a plan; any other prompt gets "ok". Every `session/new` is appended to `sessions.jsonl` in the
working directory the host started it in (the agent's folder for the chat, `background` for the tidy). The plan
adds one line the user said and one only the bot did, which the host's audit drops.
"""
import json
import os
import sys

PLAN = {
    "add": [
        {
            "text": "Prefers tea over coffee",
            "quote": "I prefer tea over coffee",
            "message": "m1",
        },
        # Said only by the bot: the audit drops it.
        {"text": "Loves durian", "quote": "durian", "message": "m2"},
    ],
    "archive": [],
    "review": [],
    "append": [],
}

sessions = 0
system = {}


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "_meta": {"claudeCode": {}}}}
    elif method == "session/new":
        sessions += 1
        sid = f"{os.getpid()}-{sessions}"
        prompt = (params.get("_meta") or {}).get("systemPrompt")
        system[sid] = prompt if isinstance(prompt, str) else ""
        with open("sessions.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps({"sessionId": sid, "params": params}) + "\n")
        result = {"sessionId": sid}
    elif method == "session/load":
        result = {}
    elif method == "session/prompt":
        sid = params["sessionId"]
        if system.get(sid, "").startswith("You keep the memory"):
            reply = "Here is the plan:\n" + json.dumps(PLAN)
            result = {"stopReason": "end_turn",
                      "usage": {"inputTokens": 120, "outputTokens": 30, "cachedReadTokens": 10, "cachedWriteTokens": 5}}
        else:
            reply = "ok"
            result = {"stopReason": "end_turn"}
        send({"method": "session/update", "params": {"sessionId": sid, "update": {
            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply}}}})
    else:
        result = {}
    if "id" in request:
        send({"id": request["id"], "result": result})
