# Minimal ACP agent for the bot-guest end-to-end: answers every prompt with "Echo: " and the prompt's text, in two chunks.
import json
import sys


def send(m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


def chunk(session, text):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": session, "update": {"sessionUpdate": "agent_message_chunk",
                                                      "content": {"type": "text", "text": text}}}})


sessions = 0
for line in sys.stdin:
    m = json.loads(line)
    if "method" not in m:
        continue
    method = m["method"]
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": False}}})
    elif method == "session/new":
        sessions += 1
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": f"s{sessions}"}})
    elif method == "session/prompt":
        session = m["params"]["sessionId"]
        text = "".join(p.get("text", "") for p in m["params"]["prompt"])
        chunk(session, "Echo: ")
        chunk(session, text)
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
    elif "id" in m:
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
