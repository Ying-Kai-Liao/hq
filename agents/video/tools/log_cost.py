#!/usr/bin/env python3
"""Log what one delivered video cost, in <dir>/costs.jsonl, and print the project's running list.

usage: log_cost.py <video-dir> <video-name> <since-iso-utc> --kind marketing [--mode hybrid] [--api 0.02] [--note "..."]
--kind: what the video is (screen-demo, marketing, launch, explainer, social, ...); --mode: how it was made (optional).

Claude cost comes from the hq cost ledger (bin/hq-cost): the video agent's requests since <since>, i.e. `hq video`
runs and hq:video subagents (the ledger's hq_req view). Outside an hq run (video work done in a plain session) it falls
back to the session that is writing its transcript now, and says so in `source`.
--api adds paid outside calls (cloud TTS etc.). Rendering, Kokoro and Whisper run locally and cost nothing.
"""
import argparse, glob, json, os, sqlite3, subprocess
from datetime import datetime, timezone
from pathlib import Path

HQ = Path(__file__).resolve().parents[3]
ap = argparse.ArgumentParser()
ap.add_argument('dir'); ap.add_argument('name'); ap.add_argument('since')
ap.add_argument('--kind', required=True); ap.add_argument('--mode', default='')
ap.add_argument('--api', type=float, default=0.0); ap.add_argument('--note', default='')
a = ap.parse_args()

subprocess.run([str(HQ / 'bin/hq-cost'), 'sync'], capture_output=True)
c = sqlite3.connect(Path.home() / '.config/hq/cost.db')
claude, n, sessions, version, models = c.execute(
    '''select coalesce(sum(cost), 0), count(*), group_concat(distinct substr(session, 1, 8)), max(version),
              group_concat(distinct model) from hq_req where hq_agent = 'video' and ts >= ?''', (a.since,)).fetchone()
source = 'hq video'
if not n:
    latest = max(glob.glob(str(Path.home() / '.claude/projects/*/*.jsonl')), key=os.path.getmtime)
    sessions = Path(latest).stem[:8]
    claude, n, models = c.execute('''select coalesce(sum(cost), 0), count(*), group_concat(distinct model) from req
                                     where session like ? and ts >= ?''', (sessions + '%', a.since)).fetchone()
    source = 'session'

row = {'date': datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M'), 'video': a.name, 'kind': a.kind,
       'mode': a.mode, 'claude_usd': round(claude, 2), 'requests': n, 'api_usd': a.api,
       'total_usd': round(claude + a.api, 2), 'note': a.note, 'source': source, 'sessions': sessions,
       'version': version, 'models': models}
log = Path(a.dir).expanduser() / 'costs.jsonl'
log.parent.mkdir(parents=True, exist_ok=True)
with log.open('a') as f:
    f.write(json.dumps(row) + '\n')
for line in log.read_text().splitlines():
    r = json.loads(line)
    print(f"{r['date']}  ${r['total_usd']:>6.2f}  {r['video']:<22} {r.get('kind', ''):<12} {r['mode']:<14} {r['note']}")
