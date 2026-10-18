"""ACP fixture that edits memory files with its own tools, the way a harness's Write and Edit do.

It advertises `additionalDirectories`. A prompt `WRITE <path>` followed by a line break writes the rest of the
prompt to that file; `DELETE <path>` removes it. Either reports a tool call naming the path in its `locations`.
Every request is appended to `requests.jsonl` in the working directory.
"""
import json
import os
import sys


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def update(session, value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})


sessions = 0
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    with open("requests.jsonl", "a", encoding="utf-8") as log:
        log.write(json.dumps({"method": method, "params": params}) + "\n")
    if method == "initialize":
        result = {"protocolVersion": 1,
                  "agentCapabilities": {"sessionCapabilities": {"systemPrompt": {}, "additionalDirectories": {}}}}
    elif method == "session/new":
        sessions += 1
        result = {"sessionId": f"s{sessions}"}
    elif method == "session/prompt":
        session = params["sessionId"]
        # The user's words come last, after any notice the host put before them.
        text = params["prompt"][0]["text"]
        command = text[text.rfind("WRITE "):] if "WRITE " in text else text[text.rfind("DELETE "):] if "DELETE " in text else ""
        if command:
            head, _, body = command.partition("\n")
            verb, path = head.split(" ", 1)
            if verb == "WRITE":
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(body)
            elif os.path.exists(path):
                os.remove(path)
            update(session, {"sessionUpdate": "tool_call", "toolCallId": f"t{request['id']}", "title": f"Edit {path}",
                             "kind": "edit", "status": "completed", "locations": [{"path": path}]})
        update(session, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ok"}})
        result = {"stopReason": "end_turn"}
    else:
        result = {}
    if "id" in request:
        send({"id": request["id"], "result": result})
