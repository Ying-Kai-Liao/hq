"""ACP fixture recording the actual process and session working directories."""
import json
import os
import sys
from pathlib import Path


def send(value):
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": False}}
    elif method == "session/new":
        Path("execution.json").write_text(json.dumps({
            "process": os.getcwd(), "session": message["params"]["cwd"]
        }))
        result = {"sessionId": "workspace-test"}
    elif method == "session/prompt":
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "workspace-test", "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Workspace verified"}
            }
        }})
        result = {"stopReason": "end_turn"}
    else:
        continue
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
