---
name: monitor
description: Read the Mac mini's always-on health monitor (monitor.py) to answer "why is it laggy", "is the Mac OK", "was the internet down", "did it restart" — CPU, memory, network, reboots and crash reports, live and history.
---

# Mac health monitor

Tool: `<pkg>/tools/monitor.py <command>` (written `monitor` below), where `<pkg>` is your package folder
(`{{AGENT_DIR}}` in your instructions). Output is JSON. It runs through uv; call it directly, not with python3.

A LaunchAgent (`dev.hq.monitor`) samples every minute and keeps 30 days in `~/.config/hq/monitor/monitor.db`.
It alerts the user itself (hq-send as devops); you are for questions and diagnosis.

## Commands
- `monitor status`: latest sample, last-hour summary, problems active right now, and whether the loop is alive
  (`monitor_running: false` → check `launchctl list dev.hq.monitor` and `~/.config/hq/monitor/monitor.log`).
- `monitor report --hours N`: summary overall and per hour, plus events. Use it for "when was it laggy and why".
- `monitor events --hours N`: alerts, recoveries, outages, reboots, crash reports.
- `monitor sample`: a fresh sample now (takes ~5 s).
- `monitor install` / `uninstall`: (re)install the LaunchAgent. Changes the machine; needs approval.

## Reading it
- **load** is the 1/5/15-minute load average; the Mac has 10 cores. Sustained load1 > 20 feels frozen.
- **mem_free** is % free (kernel memory status). Below ~15% macOS starts killing apps (Jetsam).
- **internet / router**: ping ms and % loss to 1.1.1.1 and the gateway. Router bad too → Wi-Fi/LAN problem on
  this Mac; router fine but internet bad → ISP or router uplink. **wifi** (every 5 min, only when on Wi-Fi):
  channel/band and signal; 2.4 GHz at 20 MHz is slow and crowded.
- **top_cpu / top_mem** name the culprit; `node (vitest, <project>)` is a test suite, often a flow worker's.
  **claude** counts Claude Code sessions and their total MB.
- **users** logged in at the console: two means two full sessions competing; the second account's iCloud Photos
  and Spotlight catch-up is a known load spike (which accounts this machine has: your memory).
- Crash events explain themselves: "power button held" = someone forced a restart after a freeze;
  "out of memory" = Jetsam.

## Answering
Lead with the cause in one line (e.g. "Laggy 14:00–14:20: a vitest run in peace-guardian, load 30; network fine"),
then the numbers that show it, then what would fix it. Don't paste JSON. If the monitor wasn't running for the
period asked about, say so.
