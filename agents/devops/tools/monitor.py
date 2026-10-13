#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.10"
# ///
"""monitor — always-on health monitor for the Mac mini. Stdlib only.

Samples every minute: load, memory, swap, top processes, who is logged in, screen-sharing peers, the hq bridge,
network latency/loss to the router and the internet, Wi-Fi band and signal. Stores history and alerts the user
(hq-send, Telegram outside Discord) when something goes wrong. Alerts raised while the internet is down are queued
and sent when it's back, with the outage length. Reboots are reported with their cause (power-button reset, panic).

  monitor.py run [--interval 60]      the loop (launchd runs this)
  monitor.py sample                   take one sample now and print it
  monitor.py status                   latest sample + last hour summary
  monitor.py report [--hours 24]      per-hour summary and incidents (when was it laggy, and why)
  monitor.py events [--hours 24]      alerts, outages, reboots, crash reports
  monitor.py install | uninstall      the LaunchAgent dev.hq.monitor

launchd runs it through ~/.config/hq/bin/hq-uv, a copy of uv with Full Disk Access (the repo is on an external SSD).
Data: ~/.config/hq/monitor/monitor.db (internal disk, survives the SSD going away). Output is JSON.
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HQ = Path(os.path.abspath(__file__)).parents[3]  # keep the ~/Workspace/hq symlink path
STATE_DIR = Path.home() / '.config' / 'hq' / 'monitor'
DB = STATE_DIR / 'monitor.db'
LABEL = 'dev.hq.monitor'
# fixed-path copy of uv with Full Disk Access (survives brew upgrade uv); see bin/hq-bridge --launcher
LAUNCHER = Path.home() / '.config' / 'hq' / 'bin' / 'hq-uv'
REPORTS = Path('/Library/Logs/DiagnosticReports')
CRASH_RE = re.compile(r'(panic|forceReset|ResetCounter|Jetsam|shutdown|stall)', re.I)

NCPU = os.cpu_count() or 8
LIMITS = {
    'load': NCPU * 2.0,        # load1 above this for 3 samples → overloaded
    'mem_free': 15,            # % free below this → memory pressure
    'swap_mb': 2048,
    'net_ms': 300,             # avg internet ping above this for 3 samples → degraded
    'net_loss': 30,            # % loss
}
COOLDOWN = 30 * 60             # same alert at most every 30 min


def sh(cmd, timeout=15):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (subprocess.TimeoutExpired, OSError):
        return ''


def db():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.executescript("""
      CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, text TEXT, sent INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    """)
    return con


def kv(con, k, v=None):
    if v is None:
        row = con.execute('SELECT v FROM kv WHERE k=?', (k,)).fetchone()
        return json.loads(row[0]) if row else None
    con.execute('INSERT OR REPLACE INTO kv VALUES(?,?)', (k, json.dumps(v)))


# ---------- sampling ----------

def ping_start(host):
    return subprocess.Popen(['ping', '-c', '5', '-i', '0.2', '-t', '5', host],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


def ping_result(p):
    try:
        out = p.communicate(timeout=10)[0]
    except subprocess.TimeoutExpired:
        p.kill()
        return {'loss': 100, 'ms': None}
    loss = re.search(r'([\d.]+)% packet loss', out)
    avg = re.search(r'= [\d.]+/([\d.]+)/', out)
    return {'loss': round(float(loss.group(1))) if loss else 100, 'ms': round(float(avg.group(1))) if avg else None}


def proc_name(comm):
    name = comm.rsplit('/', 1)[-1]
    return 'claude' if re.fullmatch(r'\d+\.\d+\.\d+', name) else name


def detail(pid, name):
    """'node' says little: add the tool and project (e.g. node (vitest, peace-guardian))."""
    if name not in ('node', 'python3', 'python', 'bun', 'deno', 'ruby', 'java'):
        return name
    args = sh(['ps', '-o', 'args=', '-p', str(pid)])
    tool = next((t for t in ('vitest', 'jest', 'next', 'vite', 'tsc', 'webpack', 'esbuild', 'playwright', 'pytest', 'uvicorn')
                 if re.search(rf'\b{t}\b', args)), None)
    proj = re.search(r'/(?:Workspace|Projects|src|code)/([^/ ]+)', args)
    extra = ', '.join(x for x in (tool, proj and proj.group(1)) if x)
    return f'{name} ({extra})' if extra else name


def top_procs():
    rows = []
    for line in sh(['ps', '-Ao', 'pid=,pcpu=,rss=,user=,comm=']).splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            rows.append({'pid': int(parts[0]), 'cpu': float(parts[1]), 'mb': int(parts[2]) // 1024, 'user': parts[3],
                         'name': proc_name(parts[4])})
    by_cpu = sorted(rows, key=lambda r: -r['cpu'])[:5]
    by_mem = sorted(rows, key=lambda r: -r['mb'])[:5]
    for r in {id(r): r for r in by_cpu + by_mem}.values():
        r['name'] = detail(r.pop('pid'), r['name'])
    claude = [r for r in rows if r['name'] == 'claude']
    return by_cpu, by_mem, {'n': len(claude), 'mb': sum(r['mb'] for r in claude)}


def wifi():
    out = sh(['system_profiler', 'SPAirPortDataType'], timeout=20)
    cur = out.split('Current Network Information:', 1)
    if len(cur) < 2:
        return None
    block = cur[1].split('Other Local Wi-Fi Networks', 1)[0]
    get = lambda k: (m.group(1).strip() if (m := re.search(rf'{k}: (.+)', block)) else None)
    rssi = re.search(r'Signal / Noise: (-?\d+) dBm', block)
    return {'channel': get('Channel'), 'rssi': int(rssi.group(1)) if rssi else None, 'rate': get('Transmit Rate')}


def sample(con, with_wifi):
    gw = (re.search(r'gateway: (\S+)', sh(['route', '-n', 'get', 'default'])) or [None, None])[1]
    pings = {'router': ping_start(gw) if gw else None, 'internet': ping_start('1.1.1.1')}
    iface = (re.search(r'interface: (\S+)', sh(['route', '-n', 'get', 'default'])) or [None, None])[1]
    load = [float(x) for x in sh(['sysctl', '-n', 'vm.loadavg']).strip(' {}\n').split()[:3]]
    swap = re.search(r'used = ([\d.]+)M', sh(['sysctl', '-n', 'vm.swapusage']))
    boot = re.search(r'sec = (\d+)', sh(['sysctl', '-n', 'kern.boottime']))
    by_cpu, by_mem, claude = top_procs()
    who = sh(['who'])
    netstat = sh(['netstat', '-an', '-p', 'tcp'])
    bridge = re.search(r'^(\S+)\s+\S+\s+dev\.hq\.bridge$', sh(['launchctl', 'list']), re.M)
    therm = sh(['pmset', '-g', 'therm'])
    s = {
        'ts': int(time.time()),
        'load': load,
        'mem_free': int(sh(['sysctl', '-n', 'kern.memorystatus_level']).strip() or 0),
        'swap_mb': round(float(swap.group(1))) if swap else 0,
        'boot': int(boot.group(1)) if boot else None,
        'users': sorted({l.split()[0] for l in who.splitlines() if ' console ' in l}),
        'screen_sharing': len(re.findall(r'\.5900\s+\S+\s+ESTABLISHED', netstat)),
        'bridge': bool(bridge and bridge.group(1) != '-'),
        'thermal': None if 'No thermal warning' in therm else therm.strip()[:200],
        'iface': iface, 'wifi_iface': iface == 'en1',
        'top_cpu': by_cpu, 'top_mem': by_mem, 'claude': claude,
    }
    for k, p in pings.items():
        s[k] = ping_result(p) if p else {'loss': 100, 'ms': None}
    if with_wifi and s['wifi_iface']:
        s['wifi'] = wifi()
    con.execute('INSERT OR REPLACE INTO samples VALUES(?,?)', (s['ts'], json.dumps(s)))
    con.execute('DELETE FROM samples WHERE ts < ?', (s['ts'] - 30 * 86400,))
    return s


# ---------- alerts ----------

def hq_send(text):
    try:
        r = subprocess.run([str(HQ / 'bin' / 'hq-send'), '--as', 'devops', text],
                           capture_output=True, text=True, timeout=45)
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def event(con, kind, text):
    con.execute('INSERT INTO events(ts, kind, text) VALUES(?,?,?)', (int(time.time()), kind, text))


def flush(con, online):
    if not online:
        return
    for eid, ts, text in con.execute('SELECT id, ts, text FROM events WHERE sent=0 ORDER BY id').fetchall():
        late = time.time() - ts > 180
        msg = f"🖥️ {text}" + (f" (at {time.strftime('%H:%M', time.localtime(ts))}, sent late)" if late else '')
        if not hq_send(msg):
            return
        con.execute('UPDATE events SET sent=1 WHERE id=?', (eid,))


def hog(s):
    p = s['top_cpu'][0] if s['top_cpu'] else None
    return f"{p['name']} ({p['user']}) {p['cpu']:.0f}% CPU" if p else '?'


def check(con, s, recent):
    """Compare against limits; raise each problem once (with cooldown) and say when it clears."""
    active = kv(con, 'active') or {}
    last_sent = kv(con, 'last_sent') or {}
    now = s['ts']
    window = (recent + [s])[-3:]

    problems = {}
    if len(window) == 3 and all(w['load'][0] > LIMITS['load'] for w in window):
        problems['load'] = f"Mac overloaded: load {s['load'][0]:.0f} on {NCPU} cores. Top: {hog(s)}"
    if s['mem_free'] < LIMITS['mem_free']:
        m = s['top_mem'][0]
        problems['memory'] = (f"Memory low: {s['mem_free']}% free. Biggest: {m['name']} {m['mb']} MB; "
                              f"{s['claude']['n']} Claude sessions use {s['claude']['mb']} MB")
    if s['swap_mb'] > LIMITS['swap_mb']:
        problems['swap'] = f"Swapping: {s['swap_mb']} MB swap used"
    net = s['internet']
    if net['loss'] == 100:
        if len(window) >= 2 and window[-2]['internet']['loss'] == 100:   # ignore one-minute blips
            where = 'router unreachable too (Wi-Fi/LAN)' if s['router']['loss'] == 100 else 'router OK, internet down'
            problems['offline'] = f"Internet down: {where}"
        if 'network' in active:   # offline doesn't mean the degraded network recovered
            problems['network'] = ''
    elif len(window) == 3 and all((w['internet']['ms'] or 0) > LIMITS['net_ms'] or w['internet']['loss'] >= LIMITS['net_loss']
                                  for w in window):
        problems['network'] = (f"Network degraded: internet {net['ms']} ms, {net['loss']}% loss; "
                               f"router {s['router']['ms']} ms, {s['router']['loss']}% loss"
                               + (f"; Wi-Fi ch {s['wifi']['channel']} {s['wifi']['rssi']} dBm" if s.get('wifi') else ''))
    if not s['bridge']:
        problems['bridge'] = 'hq bridge (Discord) is not running'
    if s['thermal']:
        problems['thermal'] = f"Thermal warning: {s['thermal']}"

    active = {k: v if isinstance(v, dict) else {'since': v, 'alerted': True} for k, v in active.items()}
    for key, text in problems.items():
        if key not in active:
            alert = now - last_sent.get(key, 0) > COOLDOWN
            active[key] = {'since': now, 'alerted': alert}
            if alert:
                event(con, key, text)
                last_sent[key] = now
    for key in list(active):
        if key not in problems:
            st = active.pop(key)
            if st['alerted']:   # only close what the user was told about
                mins = max(1, round((now - st['since']) / 60))
                event(con, f'{key}-ok', f"Recovered: {key} back to normal after {mins} min")

    # reboots and crash reports
    last_boot = kv(con, 'boot')
    if last_boot and s['boot'] and s['boot'] != last_boot:
        down = (kv(con, 'last_ts') or s['boot'])
        event(con, 'reboot', f"Mac restarted at {time.strftime('%H:%M', time.localtime(s['boot']))}; "
                             f"monitor last saw it at {time.strftime('%d %b %H:%M', time.localtime(down))}")
    kv(con, 'boot', s['boot'])
    seen = kv(con, 'reports_mtime') or time.time()
    newest = seen
    try:
        for f in REPORTS.iterdir():
            mt = f.stat().st_mtime
            if mt > seen and CRASH_RE.search(f.name):
                event(con, 'crash', f"Crash report: {f.name}{crash_reason(f)}")
            newest = max(newest, mt)
    except OSError:
        pass
    kv(con, 'reports_mtime', newest)
    kv(con, 'active', active)
    kv(con, 'last_sent', last_sent)
    kv(con, 'last_ts', now)


def crash_reason(f):
    try:
        text = f.read_text(errors='ignore')[:20000]
    except OSError:
        return ''
    if 'btn_rst' in text:
        return ' (power button held: forced restart after a freeze)'
    if m := re.search(r'"largestProcess"\s*:\s*"([^"]+)"', text):
        return f" (out of memory; largest process {proc_name(m.group(1))})"
    if m := re.search(r'panic\(cpu \d+ caller [^)]*\): ([^\\\n]{0,120})', text):
        return f" (kernel panic: {m.group(1)})"
    return ''


# ---------- commands ----------

def recent_samples(con, seconds):
    rows = con.execute('SELECT data FROM samples WHERE ts >= ? ORDER BY ts', (int(time.time()) - seconds,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def summarize(rows):
    if not rows:
        return {}
    ms = [r['internet']['ms'] for r in rows if r['internet']['ms'] is not None]
    hogs = {}
    for r in rows:
        for p in r['top_cpu'][:2]:
            if p['cpu'] > 50:
                hogs[p['name']] = hogs.get(p['name'], 0) + 1
    return {
        'samples': len(rows),
        'load_max': max(r['load'][0] for r in rows),
        'mem_free_min': min(r['mem_free'] for r in rows),
        'swap_mb_max': max(r['swap_mb'] for r in rows),
        'internet_ms_avg': round(sum(ms) / len(ms)) if ms else None,
        'internet_ms_max': max(ms) if ms else None,
        'offline_minutes': sum(1 for r in rows if r['internet']['loss'] == 100),
        'loss_avg': round(sum(r['internet']['loss'] for r in rows) / len(rows)),
        'cpu_hogs': dict(sorted(hogs.items(), key=lambda kv_: -kv_[1])[:5]),
        'users_seen': sorted({u for r in rows for u in r['users']}),
    }


def cmd_run(args):
    con = db()
    print(f'monitor running every {args.interval}s → {DB}', flush=True)
    n = 0
    while True:
        try:
            s = sample(con, with_wifi=n % 5 == 0)
            recent = recent_samples(con, args.interval * 4)[:-1]
            check(con, s, recent)
            con.commit()
            flush(con, online=s['internet']['loss'] < 100)
            con.commit()
        except Exception as e:  # keep the loop alive; launchd restarts it if it dies anyway
            print(f'{time.strftime("%F %T")} error: {e!r}', file=sys.stderr, flush=True)
        n += 1
        time.sleep(max(5, args.interval - (time.time() % args.interval)))


def cmd_sample(_):
    con = db()
    s = sample(con, with_wifi=True)
    con.commit()
    print(json.dumps(s, indent=2))


def cmd_status(_):
    con = db()
    rows = recent_samples(con, 3600)
    active = kv(con, 'active') or {}
    print(json.dumps({'latest': rows[-1] if rows else None, 'last_hour': summarize(rows),
                      'active_problems': {k: time.strftime('%H:%M', time.localtime(v['since'] if isinstance(v, dict) else v))
                                          for k, v in active.items()},
                      'monitor_running': bool(rows and time.time() - rows[-1]['ts'] < 300)}, indent=2))


def cmd_report(args):
    con = db()
    rows = recent_samples(con, args.hours * 3600)
    hours = {}
    for r in rows:
        hours.setdefault(time.strftime('%a %H:00', time.localtime(r['ts'])), []).append(r)
    print(json.dumps({'overall': summarize(rows),
                      'by_hour': {h: summarize(v) for h, v in hours.items()},
                      'events': events(con, args.hours)}, indent=2))


def events(con, hours):
    rows = con.execute('SELECT ts, kind, text FROM events WHERE ts >= ? ORDER BY ts',
                       (int(time.time()) - hours * 3600,)).fetchall()
    return [{'at': time.strftime('%a %H:%M', time.localtime(ts)), 'kind': k, 'text': t} for ts, k, t in rows]


def cmd_events(args):
    print(json.dumps(events(db(), args.hours), indent=2))


def cmd_install(_):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    plist = Path.home() / 'Library' / 'LaunchAgents' / f'{LABEL}.plist'
    path = f"{Path.home()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    script = HQ / 'agents' / 'devops' / 'tools' / 'monitor.py'
    argv = [LAUNCHER, 'run', '--quiet', '--script', script, 'run'] if LAUNCHER.exists() else [script, 'run']
    args = ''.join(f'<string>{a}</string>' for a in argv)
    plist.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array>{args}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string><key>HOME</key><string>{Path.home()}</string></dict>
  <key>WorkingDirectory</key><string>{Path.home()}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{STATE_DIR}/monitor.log</string>
  <key>StandardErrorPath</key><string>{STATE_DIR}/monitor.log</string>
</dict></plist>
""")
    os.system(f'launchctl bootout gui/{os.getuid()}/{LABEL} 2>/dev/null; launchctl bootstrap gui/{os.getuid()} "{plist}"')
    print(f'installed {plist}; logs in {STATE_DIR}/monitor.log')


def cmd_uninstall(_):
    plist = Path.home() / 'Library' / 'LaunchAgents' / f'{LABEL}.plist'
    os.system(f'launchctl bootout gui/{os.getuid()}/{LABEL} 2>/dev/null')
    plist.unlink(missing_ok=True)
    print('uninstalled (history kept in', DB, ')')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('run'); p.add_argument('--interval', type=int, default=60); p.set_defaults(f=cmd_run)
    sub.add_parser('sample').set_defaults(f=cmd_sample)
    sub.add_parser('status').set_defaults(f=cmd_status)
    for name, f in (('report', cmd_report), ('events', cmd_events)):
        p = sub.add_parser(name); p.add_argument('--hours', type=int, default=24); p.set_defaults(f=f)
    sub.add_parser('install').set_defaults(f=cmd_install)
    sub.add_parser('uninstall').set_defaults(f=cmd_uninstall)
    args = ap.parse_args()
    args.f(args)


if __name__ == '__main__':
    main()
