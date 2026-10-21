# ACP agent for the router and parallel tests: echoes its session and the whole prompt, then works
# in short steps for ~6 s and stops at the next step after session/cancel. Each process names its
# sessions after its pid and a count, so a reply shows which agent process and session answered.
import json, os, sys, threading, time

lock = threading.Lock()
cancelled = set()
sessions = 0


def send(m):
    with lock:
        sys.stdout.write(json.dumps(m) + "\n")
        sys.stdout.flush()


def text(sid, t):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": t}}}})


def turn(rid, sid, prompt):
    cancelled.discard(sid)
    text(sid, f"[{sid}] got: " + prompt + "\n")
    for i in range(20):
        time.sleep(0.3)
        if sid in cancelled:
            send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "cancelled"}})
            return
        text(sid, f"step {i + 1}. ")
    send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})


for line in sys.stdin:
    m = json.loads(line)
    meth, p = m.get("method"), m.get("params", {})
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": False}}})
    elif meth == "session/new":
        sessions += 1
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": f"s{os.getpid()}-{sessions}"}})
    elif meth == "session/prompt":
        said = " ".join(b.get("text", "") for b in p.get("prompt", []) if b.get("type") == "text")
        threading.Thread(target=turn, args=(m["id"], p["sessionId"], said), daemon=True).start()
    elif meth == "session/cancel":
        cancelled.add(p.get("sessionId"))
    elif "id" in m and meth is not None:
        send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
