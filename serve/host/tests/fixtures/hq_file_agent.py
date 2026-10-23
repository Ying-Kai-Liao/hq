"""ACP fixture for an hq agent: shares `pic.png` through the host's `kith-files` MCP server it finds in its launch's
claude `_meta` (not in ACP's `mcpServers`), and writes what the tools said to `file-results.json` in its folder."""
import json
import os
import subprocess
import sys
from pathlib import Path

sessions = {}


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def prompt(params):
    session = sessions[params["sessionId"]]
    servers = session["_meta"]["claudeCode"]["options"]["mcpServers"]
    tool = servers["kith-files"]
    with subprocess.Popen([tool["command"], *tool["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, env=os.environ.copy()) as mcp:
        n = 0

        def request(method, arguments):
            nonlocal n
            n += 1
            mcp.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": arguments}) + "\n")
            mcp.stdin.flush()
            return json.loads(mcp.stdout.readline())["result"]

        request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
        names = [t["name"] for t in request("tools/list", {})["tools"]]
        sent = request("tools/call", {"name": "send_file", "arguments": {"path": "pic.png"}})
        Path(session["cwd"], "file-results.json").write_text(json.dumps({"tools": names, "sent": sent}))
        mcp.stdin.close()
    send({"method": "session/update", "params": {"sessionId": params["sessionId"], "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Sent."}}}})
    return {"stopReason": "end_turn"}


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "_meta": {"claudeCode": {}}}}
    elif method in ("session/new", "session/load"):
        sid = message["params"].get("sessionId", "hq-file-" + str(len(sessions)))
        sessions[sid] = message["params"]
        result = {"sessionId": sid}
    elif method == "session/prompt":
        result = prompt(message["params"])
    else:
        result = {}
    if "id" in message:
        send({"id": message["id"], "result": result})
