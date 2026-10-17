"""ACP fixture recording how a bot's instructions reach it.

`standard` advertises ACP `systemPrompt`; `reporting` reports compactions with `compaction_update`; `silent` only
shows them in `usage_update`. A prompt containing COMPACT_NOW compacts, one containing `USAGE <n>` reports that
much context in use. Every request is appended to `requests.jsonl` in the working directory.
"""
import json
import re
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "reporting"
sessions = 0


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def update(session, value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    with open("requests.jsonl", "a", encoding="utf-8") as log:
        log.write(json.dumps({"method": method, "params": params}) + "\n")
    if method == "initialize":
        capabilities = {"loadSession": False, "sessionCapabilities": {}}
        if mode == "standard":
            capabilities["sessionCapabilities"]["systemPrompt"] = {}
        result = {"protocolVersion": 1, "agentCapabilities": capabilities}
    elif method == "session/new":
        sessions += 1
        result = {"sessionId": f"s{sessions}"}
    elif method == "session/prompt":
        session = params["sessionId"]
        text = params["prompt"][0]["text"]
        if "COMPACT_NOW" in text and mode != "silent":
            update(session, {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "in_progress"})
            update(session, {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "completed"})
        usage = re.search(r"USAGE (\d+)", text)
        if usage:
            update(session, {"sessionUpdate": "usage_update", "used": int(usage.group(1)), "size": 200000})
        update(session, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ok"}})
        result = {"stopReason": "end_turn"}
    else:
        result = {}
    if "id" in request:
        send({"id": request["id"], "result": result})
