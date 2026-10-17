"""Deterministic ACP replies for dreaming, without an LLM provider.

A dream run gets a plan with two additions: one quoting what the user typed, one quoting what they pasted. Only
the first may survive the host's audit.
"""
import json
import sys
import uuid

session = ""

PLAN = {
    "add": [
        {
            "text": "Prefers concise Traditional Chinese explanations",
            "quote": "explain things to me concisely in Traditional Chinese",
            "message": "m1",
        },
        {"text": "Loves durian", "quote": "I love durian", "message": "m1"},
    ],
    "archive": [],
    "review": [],
}


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    if method == "initialize":
        result = {"agentCapabilities": {"loadSession": True}}
    elif method in ("session/new", "session/load"):
        session = params.get("sessionId", str(uuid.uuid4()))
        result = {"sessionId": session}
    elif method == "session/prompt":
        text = params["prompt"][0]["text"]
        if "You keep the memory a personal assistant bot has" in text:
            reply = "Here is the plan:\n" + json.dumps(PLAN)
        elif "You name a personal assistant bot" in text:
            reply = "NONE"
        else:
            reply = "I will keep my explanations short."
        send({"method": "session/update", "params": {"sessionId": session, "update": {
            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply}
        }}})
        result = {"stopReason": "end_turn"}
    else:
        result = {}
    if "id" in request:
        send({"id": request["id"], "result": result})
