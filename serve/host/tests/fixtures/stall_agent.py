# ACP agent whose first process stalls session/new for the first argument's seconds (a slow install or session
# load); a process started after it (the stalled one was stopped) answers at once. session/prompt echoes the prompt
# after the second argument's seconds, so a turn stays running a while. A marker file in the working directory tells
# the processes apart.
import json
import os
import sys
import time

stall = float(sys.argv[1]) if len(sys.argv) > 1 else 0
hold = float(sys.argv[2]) if len(sys.argv) > 2 else 0


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
        if not os.path.exists("stalled"):
            open("stalled", "w").close()
            time.sleep(stall)
        sessions += 1
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": f"s{os.getpid()}-{sessions}"}})
    elif method == "session/prompt":
        time.sleep(hold)
        chunk(m["params"]["sessionId"], "Echo: " + "".join(p.get("text", "") for p in m["params"]["prompt"]))
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": "end_turn"}})
    elif "id" in m:
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
