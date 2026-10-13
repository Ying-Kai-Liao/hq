#!/usr/bin/env python3
"""house — the house agent's records: pantry, shopping list, shared money, bills. Stdlib only (python3 >= 3.9).

Code does the deterministic part (store, dates, split maths, reminders). The agent does the judgement: reading a
receipt, guessing shelf life, deciding which group a cost belongs to.

  house status                                   everything that needs attention, in one view
  house people | house person add KEY NAME | house group add KEY --members a,b [--name N]

  house pantry add NAME [--qty Q] [--unit U] [--where fridge|freezer|pantry] [--expires DATE|+Nd] [--estimated]
                        [--source S] [--note N]
  house pantry import FILE|-      JSON list of items (from a receipt); also ticks matching shopping items
  house pantry list [--expiring N] [--where W] [--all]
  house pantry use ID... | house pantry toss ID... | house pantry edit ID [--qty …] [--expires …] [--where …]

  house shop add ITEM [--qty Q] [--note N] [--by P]
  house shop list [--all] | house shop got ID|NAME... | house shop drop ID...

  house spend AMOUNT --by P --group G [--among a,b] [--split a=2,b=1 | a:30,b:12.5] [--note N] [--date D]
  house settle AMOUNT --from P --to P --group G [--note N]
  house balance [--group G] | house history [--group G] [--limit N] | house undo [--group G]

  house bill add NAME --due DATE [--amount A] [--every week|fortnight|month|2months|quarter|year] [--provider P]
                      [--group G] [--autopay] [--note N]
  house bill ingest FILE|-        JSON from an email or webhook: {name, provider, amount, due, every?, group?, ref?}
  house bill list [--days N] [--all]
  house bill paid ID [--by P] [--amount A] [--no-log]   logs the payment as a group expense, schedules the next one
  house bill edit ID [--amount …] [--due …] [--every …] | house bill drop ID

  house dish add NAME --ingredients "chicken thigh, soy sauce" [--optional "spring onion"] [--tags quick,chinese]
                     [--minutes N] [--url U] [--note N] [--steps "1. …\n2. …"] [--photo IMAGE_URL]
                     [--by P|personal] [--cooked [DATE]] [--rating 1-5]
  house dish cooked NAME|ID [--date D] [--by P] [--rating 1-5] [--note N]   adds the dish if it's new
  house dish list [--tag T] [--search Q] [--tried|--to-try] | house dish show NAME|ID | house dish edit ID … | drop ID
  house cook suggest [--limit 5] [--tag T]    ranked by what's in stock, what's expiring, and not cooked lately
  house cook need NAME|ID [--add]             what's missing for a dish; --add puts it on the shopping list

  house remind [--bill-days 3] [--food-days 2] [--send]   the daily ping; prints it, --send posts it (hq-send)
  house config [KEY [VALUE]]                             e.g. telegram_chat, default_group, notion_parent
  house notion [--parent PAGE_ID] [--all]                one-way mirror to Notion (auto after writes once set up)

Amounts are AUD dollars on input, stored as cents. Dates are local (Australia/Sydney by the Mac's clock).
Data: $HOUSE_DATA or <agent home>/data (house.db, config.json, notion.json). Output is JSON unless noted.
"""
import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Runs from a pinned package snapshot (hq-pkg); state lives in the agent's folder under the state root, which .home
# names. Run from the live package (launchd, another agent): $HQ_STATE, else ~/.hq, else the package itself.
# Not HQ_AGENT_HOME: other agents (personal) run this tool too, and theirs would point at their own home.
def _home(name):
    if os.path.exists(os.path.join(PKG_DIR, '.home')):
        return open(os.path.join(PKG_DIR, '.home')).read().strip()
    dot = os.path.expanduser('~/.hq')
    state = os.environ.get('HQ_STATE') or (dot if os.path.isdir(dot) else '')
    return os.path.join(state, 'agents', name) if state else PKG_DIR


AGENT_DIR = _home('house')
DATA = os.environ.get('HOUSE_DATA') or os.path.join(AGENT_DIR, 'data')
DB = os.path.join(DATA, 'house.db')
CONF = os.path.join(DATA, 'config.json')
HQ = os.path.dirname(os.path.dirname(AGENT_DIR))

WHERE = ['fridge', 'freezer', 'pantry', 'other']
EVERY = {'week': (7, 0), 'fortnight': (14, 0), 'month': (0, 1), '2months': (0, 2), 'quarter': (0, 3), 'year': (0, 12)}

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (key TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups_ (key TEXT PRIMARY KEY, name TEXT, members TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pantry (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty REAL, unit TEXT, location TEXT,
  expires_on TEXT, expiry_estimated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in', source TEXT, note TEXT,
  added_at TEXT NOT NULL, updated_at TEXT, notion_id TEXT, notion_synced_at TEXT);
CREATE TABLE IF NOT EXISTS shopping (
  id INTEGER PRIMARY KEY, item TEXT NOT NULL, qty TEXT, note TEXT, added_by TEXT,
  status TEXT NOT NULL DEFAULT 'need', added_at TEXT NOT NULL, updated_at TEXT, notion_id TEXT, notion_synced_at TEXT);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, grp TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense',
  paid_by TEXT NOT NULL, to_person TEXT, amount_cents INTEGER NOT NULL, shares TEXT,
  note TEXT, bill_id INTEGER, ts TEXT NOT NULL, voided_at TEXT,
  updated_at TEXT, notion_id TEXT, notion_synced_at TEXT);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider TEXT, amount_cents INTEGER, amount_estimated INTEGER DEFAULT 0,
  due_on TEXT NOT NULL, every TEXT, grp TEXT, autopay INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'due', paid_at TEXT, paid_by TEXT, ref TEXT, source TEXT, note TEXT,
  added_at TEXT NOT NULL, updated_at TEXT, notion_id TEXT, notion_synced_at TEXT);
CREATE INDEX IF NOT EXISTS idx_pantry_exp ON pantry(status, expires_on);
CREATE INDEX IF NOT EXISTS idx_bills_due ON bills(status, due_on);
CREATE INDEX IF NOT EXISTS idx_exp_grp ON expenses(grp, voided_at);
CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, ingredients TEXT, optional TEXT, tags TEXT,
  minutes INTEGER, url TEXT, note TEXT, added_by TEXT, status TEXT NOT NULL DEFAULT 'active',
  added_at TEXT NOT NULL, updated_at TEXT, notion_id TEXT, notion_synced_at TEXT);
CREATE TABLE IF NOT EXISTS cooked (
  id INTEGER PRIMARY KEY, dish_id INTEGER NOT NULL, date TEXT NOT NULL, by TEXT, rating INTEGER, note TEXT,
  added_at TEXT NOT NULL);
"""



# ---------- basics ----------

def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def today():
    return dt.date.today()


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1, default=str))


def die(msg, code=1):
    print('house: ' + msg, file=sys.stderr)
    sys.exit(code)


def db():
    os.makedirs(DATA, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    for col in ('steps', 'photo', 'notion_body'):  # added after the first release
        if col not in [c[1] for c in con.execute('PRAGMA table_info(dishes)')]:
            con.execute(f'ALTER TABLE dishes ADD COLUMN {col} TEXT')
    # A new database starts with the household from config.json, if it names one:
    # {"people": [["key", "Name"], ...], "groups": [["key", "Name", "key1,key2"], ...]}; else `house person/group add`.
    if not con.execute('SELECT 1 FROM people').fetchone():
        c = conf()
        con.executemany('INSERT INTO people VALUES (?, ?)', [tuple(p) for p in c.get('people', [])])
        con.executemany('INSERT INTO groups_ VALUES (?, ?, ?)', [tuple(g) for g in c.get('groups', [])])
        con.commit()
    return con


def conf():
    return json.load(open(CONF)) if os.path.exists(CONF) else {}


def cents(text):
    m = re.fullmatch(r'\$?\s*(-?\d+(?:\.\d{1,2})?)', str(text).strip().replace(',', ''))
    if not m:
        die(f'not an amount: {text!r}')
    return int(round(float(m.group(1)) * 100))


def money(c):
    return None if c is None else ('-' if c < 0 else '') + f'${abs(c) / 100:,.2f}'


def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y, m = d.year + y, m + 1
    last = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).day
    return dt.date(y, m, min(d.day, last))


def parse_date(text):
    """YYYY-MM-DD, DD/MM[/YYYY] (Australian order), +Nd/+Nw/+Nm, today, tomorrow, a weekday (the next one)."""
    t = str(text).strip().lower()
    days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    if t[:3] in days and re.fullmatch(r'[a-z]+', t):
        return (today() + dt.timedelta(days=(days.index(t[:3]) - today().weekday()) % 7)).isoformat()
    if t in ('today', 'tomorrow'):
        return (today() + dt.timedelta(days=t == 'tomorrow')).isoformat()
    m = re.fullmatch(r'\+(\d+)([dwm])', t)
    if m:
        n, u = int(m.group(1)), m.group(2)
        return (add_months(today(), n) if u == 'm' else today() + dt.timedelta(days=n * (7 if u == 'w' else 1))).isoformat()
    m = re.fullmatch(r'(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?', t)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
        y = int(y) + (2000 if y and len(y) == 2 else 0) if y else today().year
        try:
            return dt.date(y, mo, d).isoformat()
        except ValueError:
            die(f'not a date: {text!r}')
    try:
        return dt.date.fromisoformat(t[:10]).isoformat()
    except ValueError:
        die(f'not a date: {text!r} (use YYYY-MM-DD, DD/MM, +5d)')


def days_until(iso):
    return (dt.date.fromisoformat(iso) - today()).days


def day(iso):
    """'Thu 15/10': the label to quote, so nobody has to work out weekdays."""
    d = dt.date.fromisoformat(iso[:10])
    return d.strftime('%a ') + f'{d.day}/{d.month}' + ('' if d.year == today().year else f'/{d.year}')


def when(iso):
    n = days_until(iso)
    return {0: 'today', 1: 'tomorrow', -1: 'yesterday'}.get(n, f'in {n} days' if n > 0 else f'{-n} days ago')


def people(con):
    return {r['key']: r['name'] for r in con.execute('SELECT * FROM people')}


def group(con, key):
    key = key or conf().get('default_group')
    if not key:
        die('say which group (--group): ' + ', '.join(r['key'] for r in con.execute('SELECT key FROM groups_')))
    r = con.execute('SELECT * FROM groups_ WHERE key = ?', (key,)).fetchone()
    if not r:
        die(f'no group {key!r}; groups: ' + ', '.join(r['key'] for r in con.execute('SELECT key FROM groups_')))
    return r['key'], r['members'].split(',')


def person(con, key):
    key = (key or '').strip().lower()
    ppl = people(con)
    if key in ppl:
        return key
    hits = [k for k, n in ppl.items() if n.lower() == key or n.lower().startswith(key) or k.startswith(key)] if key else []
    if len(hits) == 1:
        return hits[0]
    die(f'who is {key!r}? people: ' + ', '.join(ppl))


def touch(con, table, rid):
    con.execute(f'UPDATE {table} SET updated_at = ? WHERE id = ?', (now(), rid))


# ---------- people and groups ----------

def cmd_people(con, a):
    out({'people': people(con),
         'groups': {r['key']: {'name': r['name'], 'members': r['members'].split(',')}
                    for r in con.execute('SELECT * FROM groups_')}})


def cmd_person_add(con, a):
    con.execute('INSERT OR REPLACE INTO people VALUES (?, ?)', (a.key.lower(), a.name))
    con.commit()
    cmd_people(con, a)


def cmd_group_add(con, a):
    members = [person(con, m) for m in a.members.split(',')]
    con.execute('INSERT OR REPLACE INTO groups_ VALUES (?, ?, ?)', (a.key.lower(), a.name or a.key, ','.join(members)))
    con.commit()
    cmd_people(con, a)


# ---------- pantry ----------

def pantry_row(r):
    d = {'id': r['id'], 'name': r['name'], 'qty': r['qty'], 'unit': r['unit'], 'where': r['location'],
         'expires': r['expires_on'], 'estimated': bool(r['expiry_estimated']), 'status': r['status']}
    if r['expires_on']:
        d['expires_in_days'], d['expires_day'] = days_until(r['expires_on']), day(r['expires_on'])
    if r['source']:
        d['source'] = r['source']
    if r['note']:
        d['note'] = r['note']
    return {k: v for k, v in d.items() if v is not None}


def pantry_insert(con, it, source=None):
    if not it.get('name'):
        die('every pantry item needs a name')
    loc = (it.get('where') or it.get('location') or '').lower() or None
    if loc and loc not in WHERE:
        die(f'where must be one of {WHERE}')
    exp = parse_date(it['expires']) if it.get('expires') else None
    cur = con.execute('INSERT INTO pantry (name, qty, unit, location, expires_on, expiry_estimated, source, note, added_at)'
                      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                      (it['name'].strip(), it.get('qty'), it.get('unit'), loc, exp, int(bool(it.get('estimated'))),
                       it.get('source') or source, it.get('note'), now()))
    return cur.lastrowid


def tick_shopping(con, names):
    """Items bought: mark matching 'need' entries got. Whole-word match either way round."""
    got = []
    for r in con.execute("SELECT id, item FROM shopping WHERE status = 'need'").fetchall():
        want = r['item'].lower()
        for n in names:
            n = n.lower()
            if re.search(r'\b' + re.escape(want) + r's?\b', n) or re.search(r'\b' + re.escape(n) + r'\b', want):
                con.execute("UPDATE shopping SET status = 'got', updated_at = ? WHERE id = ?", (now(), r['id']))
                got.append({'id': r['id'], 'item': r['item']})
                break
    return got


def cmd_pantry_add(con, a):
    rid = pantry_insert(con, {'name': a.name, 'qty': a.qty, 'unit': a.unit, 'where': a.where, 'expires': a.expires,
                              'estimated': a.estimated, 'note': a.note}, a.source or 'said')
    ticked = tick_shopping(con, [a.name])
    con.commit()
    out({'added': pantry_row(con.execute('SELECT * FROM pantry WHERE id = ?', (rid,)).fetchone()),
         'shopping_ticked': ticked})


def read_json(path):
    try:
        return json.load(sys.stdin if path == '-' else open(path))
    except (OSError, ValueError) as e:
        die(f'bad JSON input: {e}')


def cmd_pantry_import(con, a):
    items = read_json(a.file)
    if isinstance(items, dict):
        source, items = items.get('source'), items.get('items', [])
    else:
        source = None
    ids = [pantry_insert(con, it, source or a.source or 'receipt') for it in items]
    ticked = tick_shopping(con, [it['name'] for it in items])
    con.commit()
    rows = [pantry_row(con.execute('SELECT * FROM pantry WHERE id = ?', (i,)).fetchone()) for i in ids]
    out({'added': rows, 'count': len(rows), 'shopping_ticked': ticked,
         'no_expiry': [r['name'] for r in rows if 'expires' not in r]})


def cmd_pantry_list(con, a):
    where, params = ["status = 'in'"] if not a.all else ['1=1'], []
    if a.where:
        where.append('location = ?')
        params.append(a.where)
    if a.expiring is not None:
        where.append('expires_on IS NOT NULL AND expires_on <= ?')
        params.append((today() + dt.timedelta(days=a.expiring)).isoformat())
    rows = con.execute(f"SELECT * FROM pantry WHERE {' AND '.join(where)} "
                       'ORDER BY expires_on IS NULL, expires_on, name', params).fetchall()
    out({'items': [pantry_row(r) for r in rows], 'count': len(rows)})


def pantry_set_status(con, ids, status):
    done = []
    for i in ids:
        r = con.execute('SELECT * FROM pantry WHERE id = ?', (i,)).fetchone()
        if not r:
            die(f'no pantry item {i}')
        con.execute('UPDATE pantry SET status = ?, updated_at = ? WHERE id = ?', (status, now(), i))
        done.append({'id': i, 'name': r['name'], 'status': status})
    con.commit()
    out({'updated': done})


def cmd_pantry_edit(con, a):
    r = con.execute('SELECT * FROM pantry WHERE id = ?', (a.id,)).fetchone() or die(f'no pantry item {a.id}')
    sets = {}
    if a.qty is not None:
        sets['qty'] = a.qty
    if a.unit:
        sets['unit'] = a.unit
    if a.where:
        sets['location'] = a.where
    if a.expires:
        sets['expires_on'], sets['expiry_estimated'] = parse_date(a.expires), int(bool(a.estimated))
    if a.name:
        sets['name'] = a.name
    if a.note is not None:
        sets['note'] = a.note
    if sets:
        con.execute(f"UPDATE pantry SET {', '.join(k + ' = ?' for k in sets)} WHERE id = ?", [*sets.values(), r['id']])
        touch(con, 'pantry', r['id'])
        con.commit()
    out({'item': pantry_row(con.execute('SELECT * FROM pantry WHERE id = ?', (a.id,)).fetchone())})


# ---------- shopping ----------

def shop_row(r):
    return {k: v for k, v in {'id': r['id'], 'item': r['item'], 'qty': r['qty'], 'note': r['note'],
                              'by': r['added_by'], 'status': r['status']}.items() if v is not None}


def cmd_shop_add(con, a):
    by = person(con, a.by) if a.by else None
    dup = con.execute("SELECT * FROM shopping WHERE status = 'need' AND lower(item) = lower(?)", (a.item,)).fetchone()
    if dup:
        out({'already_on_list': shop_row(dup)})
        return
    rid = con.execute('INSERT INTO shopping (item, qty, note, added_by, added_at) VALUES (?, ?, ?, ?, ?)',
                      (a.item.strip(), a.qty, a.note, by, now())).lastrowid
    con.commit()
    out({'added': shop_row(con.execute('SELECT * FROM shopping WHERE id = ?', (rid,)).fetchone())})


def cmd_shop_list(con, a):
    rows = con.execute("SELECT * FROM shopping WHERE status = 'need' OR ? ORDER BY added_at", (int(a.all),)).fetchall()
    out({'items': [shop_row(r) for r in rows], 'count': len(rows)})


def shop_set(con, refs, status):
    done = []
    for ref in refs:
        if ref.isdigit():
            r = con.execute('SELECT * FROM shopping WHERE id = ?', (int(ref),)).fetchone()
        else:
            r = con.execute("SELECT * FROM shopping WHERE status = 'need' AND lower(item) LIKE ?",
                            ('%' + ref.lower() + '%',)).fetchone()
        if not r:
            die(f'nothing on the list matches {ref!r}')
        con.execute('UPDATE shopping SET status = ?, updated_at = ? WHERE id = ?', (status, now(), r['id']))
        done.append({'id': r['id'], 'item': r['item'], 'status': status})
    con.commit()
    out({'updated': done})


# ---------- money ----------

def split_shares(con, total, members, spec, among):
    """Return {person: cents}, summing exactly to total. spec: None (equal), 'a=2,b=1' (weights), 'a:30,b:12.5' (amounts)."""
    if spec:
        parts = [p.strip() for p in spec.split(',') if p.strip()]
        if all(':' in p for p in parts):
            shares = {person(con, k): cents(v) for k, v in (p.split(':', 1) for p in parts)}
            for p, c in shares.items():
                if p not in members:
                    die(f'{p} is not in this group ({", ".join(members)})')
                if c < 0:
                    die(f'{p}: a share can\'t be negative')
            if sum(shares.values()) != total:
                die(f'exact shares add up to {money(sum(shares.values()))}, not {money(total)}')
            return shares
        if all('=' in p for p in parts):
            weights = {person(con, k): float(v) for k, v in (p.split('=', 1) for p in parts)}
        else:
            die('split is either weights (a=2,b=1) or amounts (a:30,b:12.50)')
    else:
        weights = {person(con, p): 1.0 for p in (among.split(',') if among else members)}
    if any(w < 0 for w in weights.values()):
        die('split weights can\'t be negative')
    if not weights or sum(weights.values()) <= 0:
        die('nobody to split between')
    for p in weights:
        if p not in members:
            die(f'{p} is not in this group ({", ".join(members)})')
    total_w = sum(weights.values())
    shares = {p: int(total * w // total_w) for p, w in weights.items()}
    # Leftover cents go one each, in member order, so the split is exact and repeatable.
    for p in [p for p in members if p in weights][: total - sum(shares.values())]:
        shares[p] += 1
    return shares


def exp_row(r, ppl):
    d = {'id': r['id'], 'group': r['grp'], 'kind': r['kind'], 'date': r['ts'][:10], 'amount': money(r['amount_cents']),
         'note': r['note']}
    if r['kind'] == 'settle':
        d['from'], d['to'] = ppl.get(r['paid_by']), ppl.get(r['to_person'])
    else:
        d['paid_by'] = ppl.get(r['paid_by'])
        d['shares'] = {ppl.get(k, k): money(v) for k, v in json.loads(r['shares']).items()}
    if r['bill_id']:
        d['bill_id'] = r['bill_id']
    if r['voided_at']:
        d['voided'] = r['voided_at'][:10]
    return {k: v for k, v in d.items() if v is not None}


def add_expense(con, grp, members, by, total, spec=None, among=None, note=None, date=None, bill_id=None):
    if total <= 0:
        die('amount must be positive')
    shares = split_shares(con, total, members, spec, among)
    ts = (parse_date(date) + 'T12:00:00') if date else now()
    return con.execute('INSERT INTO expenses (grp, paid_by, amount_cents, shares, note, bill_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
                       (grp, by, total, json.dumps(shares), note, bill_id, ts)).lastrowid


def cmd_spend(con, a):
    grp, members = group(con, a.group)
    by = person(con, a.by)
    if by not in members:
        die(f'{by} is not in group {grp}')
    rid = add_expense(con, grp, members, by, cents(a.amount), a.split, a.among, a.note, a.date)
    con.commit()
    out({'logged': exp_row(con.execute('SELECT * FROM expenses WHERE id = ?', (rid,)).fetchone(), people(con)),
         'balance': balance(con, grp)})


def cmd_settle(con, a):
    grp, members = group(con, a.group)
    frm, to = person(con, a.frm), person(con, a.to)
    if frm == to or frm not in members or to not in members:
        die('settle is between two different members of the group')
    amount = cents(a.amount)
    if amount <= 0:
        die('a settlement is a positive amount; to reverse one, settle the other way')
    con.execute("INSERT INTO expenses (grp, kind, paid_by, to_person, amount_cents, note, ts) VALUES (?, 'settle', ?, ?, ?, ?, ?)",
                (grp, frm, to, amount, a.note, now()))
    con.commit()
    out({'settled': {'from': frm, 'to': to, 'amount': money(amount)}, 'balance': balance(con, grp)})


def balance(con, grp):
    net = {}
    for r in con.execute('SELECT * FROM expenses WHERE grp = ? AND voided_at IS NULL', (grp,)):
        if r['kind'] == 'settle':
            net[r['paid_by']] = net.get(r['paid_by'], 0) + r['amount_cents']
            net[r['to_person']] = net.get(r['to_person'], 0) - r['amount_cents']
        else:
            net[r['paid_by']] = net.get(r['paid_by'], 0) + r['amount_cents']
            for p, c in json.loads(r['shares']).items():
                net[p] = net.get(p, 0) - c
    # Fewest transfers: largest debtor pays largest creditor until everyone is square.
    debt = sorted([[c, p] for p, c in net.items() if c < 0])
    cred = sorted([[c, p] for p, c in net.items() if c > 0], reverse=True)
    ppl, moves = people(con), []
    while debt and cred:
        amt = min(-debt[0][0], cred[0][0])
        moves.append(f'{ppl.get(debt[0][1])} owes {ppl.get(cred[0][1])} {money(amt)}')
        debt[0][0] += amt
        cred[0][0] -= amt
        debt = [d for d in debt if d[0]]
        cred = [c for c in cred if c[0]]
    return {'group': grp, 'owes': moves or ['all square'],
            'net': {ppl.get(p, p): money(c) for p, c in sorted(net.items()) if c}}


def cmd_balance(con, a):
    keys = [group(con, a.group)[0]] if a.group else [r['key'] for r in con.execute('SELECT key FROM groups_')]
    out([balance(con, k) for k in keys])


def cmd_history(con, a):
    q, params = 'SELECT * FROM expenses', []
    if a.group:
        q += ' WHERE grp = ?'
        params.append(group(con, a.group)[0])
    rows = con.execute(q + ' ORDER BY ts DESC, id DESC LIMIT ?', params + [a.limit]).fetchall()
    ppl = people(con)
    out([exp_row(r, ppl) for r in rows])


def cmd_undo(con, a):
    q, params = 'SELECT * FROM expenses WHERE voided_at IS NULL', []
    if a.id:
        q += ' AND id = ?'
        params.append(a.id)
    elif a.group:
        q += ' AND grp = ?'
        params.append(group(con, a.group)[0])
    r = con.execute(q + ' ORDER BY id DESC LIMIT 1', params).fetchone() or die('nothing to undo')
    con.execute('UPDATE expenses SET voided_at = ?, updated_at = ? WHERE id = ?', (now(), now(), r['id']))
    if r['bill_id']:
        con.execute("UPDATE bills SET status = 'due', paid_at = NULL, paid_by = NULL, updated_at = ? WHERE id = ?",
                    (now(), r['bill_id']))
        # and take back the next one that paying it scheduled
        con.execute("UPDATE bills SET status = 'dropped', updated_at = ? WHERE status = 'due' AND source = ?",
                    (now(), f"repeat of #{r['bill_id']}"))
    con.commit()
    out({'voided': exp_row(con.execute('SELECT * FROM expenses WHERE id = ?', (r['id'],)).fetchone(), people(con)),
         'bill_reopened': r['bill_id'], 'balance': balance(con, r['grp'])})


# ---------- bills ----------

def bill_row(r):
    d = {'id': r['id'], 'name': r['name'], 'provider': r['provider'], 'amount': money(r['amount_cents']),
         'amount_estimated': bool(r['amount_estimated']) or None, 'due': r['due_on'], 'every': r['every'],
         'group': r['grp'], 'autopay': bool(r['autopay']) or None, 'status': r['status'], 'ref': r['ref'],
         'note': r['note'], 'paid': (r['paid_at'] or '')[:10] or None, 'paid_by': r['paid_by']}
    d['due_day'] = day(r['due_on'])
    if r['status'] == 'due':
        d['due_in_days'] = days_until(r['due_on'])
    return {k: v for k, v in d.items() if v is not None}


def bill_insert(con, b, source):
    if b.get('every') and b['every'] not in EVERY:
        die(f'every must be one of {list(EVERY)}')
    grp = group(con, b['group'])[0] if b.get('group') else None
    due = parse_date(b['due'])
    if b.get('ref') or b.get('provider'):  # the same bill arriving twice (email + webhook) updates, never duplicates
        dup = con.execute("SELECT id FROM bills WHERE status = 'due' AND ((ref IS NOT NULL AND ref = ?) OR "
                          "(lower(coalesce(provider, name)) = lower(?) AND due_on = ?))",
                          (b.get('ref'), b.get('provider') or b['name'], due)).fetchone()
        if dup:
            con.execute('UPDATE bills SET amount_cents = coalesce(?, amount_cents), amount_estimated = 0, updated_at = ? '
                        'WHERE id = ?', (cents(b['amount']) if b.get('amount') else None, now(), dup['id']))
            return dup['id'], False
    rid = con.execute('INSERT INTO bills (name, provider, amount_cents, due_on, every, grp, autopay, ref, source, note, added_at)'
                      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                      (b['name'], b.get('provider'), cents(b['amount']) if b.get('amount') else None, due, b.get('every'),
                       grp, int(bool(b.get('autopay'))), b.get('ref'), source, b.get('note'), now())).lastrowid
    return rid, True


def cmd_bill_add(con, a):
    rid, new = bill_insert(con, vars(a), a.source or 'said')
    con.commit()
    out({'added' if new else 'updated_existing': bill_row(con.execute('SELECT * FROM bills WHERE id = ?', (rid,)).fetchone())})


def cmd_bill_ingest(con, a):
    data = read_json(a.file)
    res = []
    for b in data if isinstance(data, list) else [data]:
        if not b.get('name') or not b.get('due'):
            die('each bill needs name and due')
        rid, new = bill_insert(con, b, b.get('source') or a.source or 'ingest')
        res.append(dict(bill_row(con.execute('SELECT * FROM bills WHERE id = ?', (rid,)).fetchone()), new=new))
    con.commit()
    out({'bills': res})


def cmd_bill_list(con, a):
    if a.all:
        rows = con.execute('SELECT * FROM bills ORDER BY due_on DESC').fetchall()
    else:
        until = (today() + dt.timedelta(days=a.days)).isoformat() if a.days is not None else '9999'
        rows = con.execute("SELECT * FROM bills WHERE status = 'due' AND due_on <= ? ORDER BY due_on", (until,)).fetchall()
    out({'bills': [bill_row(r) for r in rows], 'count': len(rows)})


def next_due(iso, every):
    d, m = EVERY[every]
    base = dt.date.fromisoformat(iso)
    return (add_months(base, m) if m else base + dt.timedelta(days=d)).isoformat()


def cmd_bill_paid(con, a):
    r = con.execute('SELECT * FROM bills WHERE id = ?', (a.id,)).fetchone() or die(f'no bill {a.id}')
    if r['status'] == 'paid':
        die(f'bill {a.id} is already paid ({r["paid_at"][:10]})')
    amount = cents(a.amount) if a.amount else r['amount_cents']
    by = person(con, a.by) if a.by else None
    res = {}
    if not a.no_log:
        if not amount or not by or not r['grp']:
            die('to log it as a shared expense I need --amount (if unknown), --by, and the bill needs a group '
                '(or pass --no-log)')
        grp, members = group(con, r['grp'])
        eid = add_expense(con, grp, members, by, amount, note=f"bill: {r['name']}", bill_id=r['id'])
        res['expense_id'] = eid
    con.execute("UPDATE bills SET status = 'paid', paid_at = ?, paid_by = ?, amount_cents = ?, amount_estimated = 0, "
                'updated_at = ? WHERE id = ?', (now(), by, amount, now(), r['id']))
    if r['every']:
        nid = con.execute('INSERT INTO bills (name, provider, amount_cents, amount_estimated, due_on, every, grp, autopay, '
                          'source, note, added_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
                          (r['name'], r['provider'], amount, next_due(r['due_on'], r['every']), r['every'], r['grp'],
                           r['autopay'], f"repeat of #{r['id']}", r['note'], now())).lastrowid
        res['next'] = bill_row(con.execute('SELECT * FROM bills WHERE id = ?', (nid,)).fetchone())
    con.commit()
    res['paid'] = bill_row(con.execute('SELECT * FROM bills WHERE id = ?', (r['id'],)).fetchone())
    if r['grp'] and not a.no_log:
        res['balance'] = balance(con, r['grp'])
    out(res)


def cmd_bill_edit(con, a):
    r = con.execute('SELECT * FROM bills WHERE id = ?', (a.id,)).fetchone() or die(f'no bill {a.id}')
    sets = {}
    if a.amount:
        sets['amount_cents'], sets['amount_estimated'] = cents(a.amount), 0
    if a.due:
        sets['due_on'] = parse_date(a.due)
    if a.every:
        if a.every not in EVERY and a.every != 'none':
            die(f'every must be one of {list(EVERY)} or none')
        sets['every'] = None if a.every == 'none' else a.every
    if a.group:
        sets['grp'] = group(con, a.group)[0]
    for k in ('name', 'provider', 'note'):
        if getattr(a, k):
            sets[k] = getattr(a, k)
    if a.autopay is not None:
        sets['autopay'] = int(a.autopay == 'yes')
    if sets:
        con.execute(f"UPDATE bills SET {', '.join(k + ' = ?' for k in sets)} WHERE id = ?", [*sets.values(), r['id']])
        touch(con, 'bills', r['id'])
        con.commit()
    out({'bill': bill_row(con.execute('SELECT * FROM bills WHERE id = ?', (a.id,)).fetchone())})


def cmd_bill_drop(con, a):
    con.execute("UPDATE bills SET status = 'dropped', updated_at = ? WHERE id = ?", (now(), a.id))
    con.commit()
    out({'dropped': a.id})



# ---------- dishes and cooking ----------

DEFAULT_STAPLES = ['salt', 'pepper', 'oil', 'olive oil', 'sesame oil', 'soy sauce', 'sugar', 'water', 'flour',
                   'vinegar', 'cornflour', 'stock powder']
NOISE = {'g', 'kg', 'ml', 'l', 'pk', 'pack', 'x', 'fresh', 'woolworths', 'ww', 'coles', 'organic', 'australian',
         'free', 'range', 'fillet', 'fillets', 'large', 'small', 'medium', 'of', 'and', 'the', 'a', 'whole'}


def tokens(text):
    out_ = set()
    for w in re.findall(r'[a-z]+', (text or '').lower()):
        if w in NOISE or len(w) < 2:
            continue
        for suf in ('ies', 'es', 's'):  # tomatoes→tomato, berries→berry, eggs→egg
            if w.endswith(suf) and len(w) > len(suf) + 2:
                w = w[: -len(suf)] + ('y' if suf == 'ies' else '')
                break
        out_.add(w)
    return out_


def split_list(text):
    return [x.strip() for x in re.split(r'[,\n;]', text or '') if x.strip()]


def staples():
    c = conf().get('staples')
    return split_list(c) if isinstance(c, str) else (c or DEFAULT_STAPLES)


def stock(con):
    return [(r, tokens(r['name'])) for r in con.execute("SELECT * FROM pantry WHERE status = 'in'")]


def have(ingredient, stock_, staple_toks):
    """The pantry row that covers this ingredient, 'staple', or None. Every word of the ingredient must be in the
    item's name ('chicken thigh' ⊆ 'Chicken thigh fillets 1kg')."""
    t = tokens(ingredient)
    if not t:
        return 'staple'
    if any(t == s_ for s_ in staple_toks):
        return 'staple'
    hits = [r for r, rt_ in stock_ if t <= rt_]
    return min(hits, key=lambda r: r['expires_on'] or '9999') if hits else None


def dish_get(con, ref, create=False, by=None):
    ref = str(ref).strip()
    r = con.execute('SELECT * FROM dishes WHERE id = ?', (int(ref),)).fetchone() if ref.isdigit() else \
        con.execute('SELECT * FROM dishes WHERE name = ?', (ref,)).fetchone()
    if not r and not ref.isdigit():
        hits = con.execute("SELECT * FROM dishes WHERE name LIKE ? AND status = 'active'", (f'%{ref}%',)).fetchall()
        if len(hits) == 1:
            r = hits[0]
        elif len(hits) > 1 and not create:
            die(f'{ref!r} matches several dishes: ' + ', '.join(f"#{h['id']} {h['name']}" for h in hits))
    if not r and create:
        rid = con.execute('INSERT INTO dishes (name, added_by, added_at) VALUES (?, ?, ?)', (ref, by, now())).lastrowid
        r = con.execute('SELECT * FROM dishes WHERE id = ?', (rid,)).fetchone()
    return r or die(f'no dish {ref!r} (house dish list)')


def dish_row(con, r, full=False):
    ck = con.execute('SELECT count(*) n, max(date) last, avg(rating) avg FROM cooked WHERE dish_id = ?', (r['id'],)).fetchone()
    d = {'id': r['id'], 'name': r['name'], 'ingredients': split_list(r['ingredients']),
         'optional': split_list(r['optional']) or None, 'tags': split_list(r['tags']) or None, 'minutes': r['minutes'],
         'times_cooked': ck['n'], 'last_cooked': ck['last'] and day(ck['last']),
         'days_since': ck['last'] and -days_until(ck['last']), 'rating': ck['avg'] and round(ck['avg'], 1),
         'url': r['url'], 'note': r['note'], 'added_by': r['added_by'], 'photo': r['photo']}
    if r['status'] != 'active':
        d['status'] = r['status']
    if full:
        d['steps'] = steps_of(r)
        d['history'] = [{k: v for k, v in dict(h, date=day(h['date'])).items() if v is not None and k not in ('id', 'dish_id', 'added_at')}
                        for h in con.execute('SELECT * FROM cooked WHERE dish_id = ? ORDER BY date DESC LIMIT 10', (r['id'],))]
    return {k: v for k, v in d.items() if v not in (None, [], '')}


def steps_of(r):
    """Method steps: one per line (or separated by ' | '), numbering stripped."""
    return [re.sub(r'^\s*(\d+[.)]|[-*•])\s*', '', x).strip() for x in re.split(r'\n| \| ', r['steps'] or '') if x.strip()]


def dish_set(con, r, a):
    sets = {}
    for k in ('ingredients', 'optional', 'tags', 'url', 'note', 'steps', 'photo'):
        v = getattr(a, k, None)
        if v is not None:
            sets[k] = ', '.join(split_list(v)) if k in ('ingredients', 'optional', 'tags') else v
    if getattr(a, 'minutes', None):
        sets['minutes'] = a.minutes
    if getattr(a, 'rename', None):
        sets['name'] = a.rename
    if sets:
        con.execute(f"UPDATE dishes SET {', '.join(k + ' = ?' for k in sets)} WHERE id = ?", [*sets.values(), r['id']])
        touch(con, 'dishes', r['id'])


def who(con, by):
    """A person key, or another agent's name (personal saves dishes too)."""
    if not by:
        return None
    return by.lower() if by.lower() in ('personal', 'house') else person(con, by)


def log_cooked(con, r, date, by, rating, note):
    if rating is not None and not 1 <= rating <= 5:
        die('rating is 1-5')
    con.execute('INSERT INTO cooked (dish_id, date, by, rating, note, added_at) VALUES (?, ?, ?, ?, ?, ?)',
                (r['id'], parse_date(date) if date else today().isoformat(), by, rating, note, now()))
    touch(con, 'dishes', r['id'])


def cmd_dish_add(con, a):
    by = who(con, a.by)
    existed = con.execute('SELECT id FROM dishes WHERE name = ?', (a.name.strip(),)).fetchone()
    r = dish_get(con, a.name.strip(), create=True, by=by)
    dish_set(con, r, a)
    if a.cooked is not None:
        log_cooked(con, r, a.cooked or None, by if by not in ('personal', 'house') else None, a.rating, None)
    con.commit()
    out({'updated' if existed else 'added': dish_row(con, con.execute('SELECT * FROM dishes WHERE id = ?', (r['id'],)).fetchone())})


def cmd_dish_cooked(con, a):
    by = who(con, a.by)
    r = dish_get(con, a.dish, create=True, by=by)
    log_cooked(con, r, a.date, by if by not in ('personal', 'house') else None, a.rating, a.note)
    con.commit()
    row = dish_row(con, con.execute('SELECT * FROM dishes WHERE id = ?', (r['id'],)).fetchone())
    res = {'cooked': row}
    if not row.get('ingredients'):
        res['todo'] = 'no ingredients yet: add them (house dish edit ID --ingredients …) so it can be suggested'
    # Pantry items it probably used, for the agent to mark `pantry use` after asking or when obvious.
    st, stp = stock(con), [tokens(x) for x in staples()]
    used = [have(i, st, stp) for i in split_list(r['ingredients'])]
    res['pantry_maybe_used'] = [{'id': u['id'], 'name': u['name']} for u in used if u not in (None, 'staple')]
    out(res)


def cmd_dish_list(con, a):
    q, params = "SELECT * FROM dishes WHERE status = 'active'", []
    if a.tag:
        q += ' AND tags LIKE ?'
        params.append(f'%{a.tag}%')
    if a.search:
        q += ' AND (name LIKE ? OR ingredients LIKE ? OR note LIKE ?)'
        params += [f'%{a.search}%'] * 3
    rows = [dish_row(con, r) for r in con.execute(q + ' ORDER BY name', params)]
    if a.tried:
        rows = [r for r in rows if r['times_cooked']]
    if a.to_try:
        rows = [r for r in rows if not r['times_cooked']]
    out({'dishes': rows, 'count': len(rows)})


def cmd_dish_show(con, a):
    out(dish_row(con, dish_get(con, a.dish), full=True))


def cmd_dish_edit(con, a):
    r = dish_get(con, a.dish)
    dish_set(con, r, a)
    con.commit()
    out({'dish': dish_row(con, con.execute('SELECT * FROM dishes WHERE id = ?', (r['id'],)).fetchone())})


def cmd_dish_drop(con, a):
    r = dish_get(con, a.dish)
    con.execute("UPDATE dishes SET status = 'dropped', updated_at = ? WHERE id = ?", (now(), r['id']))
    con.commit()
    out({'dropped': r['name']})


def dish_fit(con, r, st, stp):
    soon = (today() + dt.timedelta(days=3)).isoformat()
    ings = split_list(r['ingredients'])
    got, missing, expiring = [], [], []
    for i in ings:
        h = have(i, st, stp)
        if h is None:
            missing.append(i)
        else:
            got.append(i)
            if h != 'staple' and h['expires_on'] and h['expires_on'] <= soon:
                expiring.append(f"{h['name']} ({day(h['expires_on'])})")
    return ings, got, missing, expiring


def cmd_cook_suggest(con, a):
    st, stp = stock(con), [tokens(x) for x in staples()]
    q, params = "SELECT * FROM dishes WHERE status = 'active' AND coalesce(ingredients, '') != ''", []
    if a.tag:
        q += ' AND tags LIKE ?'
        params.append(f'%{a.tag}%')
    ranked = []
    for r in con.execute(q, params).fetchall():
        ings, got, missing, expiring = dish_fit(con, r, st, stp)
        row = dish_row(con, r)
        since = row.get('days_since')
        score = (3 * len(got) / len(ings) + 2 * len(expiring) - 0.5 * len(missing)
                 + (min(since, 30) / 30 if since is not None else 0.3)   # not cooked lately; never-cooked a little
                 + ((row['rating'] - 3) * 0.3 if row.get('rating') else 0)
                 - (1.5 if since is not None and since < 3 else 0))     # had it this week
        ranked.append((score, {'id': r['id'], 'name': r['name'], 'missing': missing, 'uses_expiring': expiring,
                               'have': f'{len(got)}/{len(ings)}', 'last_cooked': row.get('last_cooked') or 'never',
                               'rating': row.get('rating'), 'minutes': r['minutes'], 'tags': row.get('tags')}))
    ranked.sort(key=lambda x: -x[0])
    expiring_items = [f"{r['name']} ({day(r['expires_on'])})" for r, _ in st
                      if r['expires_on'] and r['expires_on'] <= (today() + dt.timedelta(days=3)).isoformat()]
    out({'suggestions': [{k: v for k, v in d.items() if v not in (None, [])} for _, d in ranked[: a.limit]],
         'expiring_soon': expiring_items, 'in_stock': [r['name'] for r, _ in st],
         'dishes_without_ingredients': [r['name'] for r in con.execute(
             "SELECT name FROM dishes WHERE status = 'active' AND coalesce(ingredients, '') = ''")]})


def cmd_cook_need(con, a):
    r = dish_get(con, a.dish)
    st, stp = stock(con), [tokens(x) for x in staples()]
    ings, got, missing, expiring = dish_fit(con, r, st, stp)
    if not ings:
        die(f"{r['name']} has no ingredients yet (house dish edit {r['id']} --ingredients …)")
    res = {'dish': r['name'], 'have': got, 'missing': missing, 'optional': split_list(r['optional']),
           'uses_expiring': expiring}
    if a.add and missing:
        added = []
        for m in missing:
            if not con.execute("SELECT 1 FROM shopping WHERE status = 'need' AND lower(item) = lower(?)", (m,)).fetchone():
                con.execute('INSERT INTO shopping (item, note, added_at) VALUES (?, ?, ?)', (m, f"for {r['name']}", now()))
                added.append(m)
        con.commit()
        res['added_to_shopping'] = added
    res['shopping_list'] = [x['item'] for x in con.execute("SELECT item FROM shopping WHERE status = 'need' ORDER BY added_at")]
    out(res)


# ---------- reminders ----------

def reminder_text(con, bill_days, food_days):
    lines = []
    until = (today() + dt.timedelta(days=bill_days)).isoformat()
    bills = con.execute("SELECT * FROM bills WHERE status = 'due' AND due_on <= ? ORDER BY due_on", (until,)).fetchall()
    if bills:
        lines.append('🧾 Bills')
        for b in bills:
            amt = money(b['amount_cents']) + (' (est.)' if b['amount_estimated'] else '') if b['amount_cents'] else 'amount ?'
            flag = '⚠️ overdue, ' if days_until(b['due_on']) < 0 else ''
            auto = ' · autopay' if b['autopay'] else ''
            lines.append(f"• {b['name']}: {amt}, {flag}due {when(b['due_on'])} ({day(b['due_on'])}){auto}")
    until = (today() + dt.timedelta(days=food_days)).isoformat()
    food = con.execute("SELECT * FROM pantry WHERE status = 'in' AND expires_on IS NOT NULL AND expires_on <= ? "
                       'ORDER BY expires_on', (until,)).fetchall()
    if food:
        lines.append('🥬 Use soon')
        for f in food:
            gone = days_until(f['expires_on']) < 0
            est = ' (est.)' if f['expiry_estimated'] else ''
            lines.append(f"• {f['name']}{' (' + f['location'] + ')' if f['location'] else ''}: "
                         f"{'expired ' if gone else ''}{when(f['expires_on'])} ({day(f['expires_on'])}){est}")
    return '\n'.join(lines)


def cmd_remind(con, a):
    text = reminder_text(con, a.bill_days, a.food_days)
    if not text:
        out({'sent': False, 'reason': 'nothing due'})
        return
    if not a.send:
        print(text)
        return
    env = dict(os.environ, HQ_AGENT='house')
    chat = conf().get('telegram_chat')
    if chat:  # the house group, posted by the bot that is a member of it (hq-auth telegram grant)
        tok = subprocess.run([os.path.join(HQ, 'bin', 'hq-auth'), 'get', '--for', 'house', 'telegram', 'TELEGRAM_BOT_TOKEN'],
                             capture_output=True, text=True).stdout.strip()
        if not tok:
            die('no Telegram bot for the house group (hq-auth grant house telegram <profile>)')
        env['HQ_TELEGRAM_BOT_TOKEN'], env['HQ_TELEGRAM_CHAT_ID'] = tok, str(chat)
    env.pop('HQ_DISCORD_WEBHOOK_URL', None)  # the daily ping goes to Telegram, never into a Discord thread
    r = subprocess.run([os.path.join(HQ, 'bin', 'hq-send'), text], env=env, capture_output=True, text=True)
    if r.returncode:
        die('send failed: ' + (r.stderr or r.stdout).strip())
    out({'sent': True, 'to': 'telegram group' if chat else 'the user (DM)', 'text': text})


def cmd_status(con, a):
    out({'bills_next_14_days': [bill_row(r) for r in con.execute(
            "SELECT * FROM bills WHERE status = 'due' AND due_on <= ? ORDER BY due_on",
            ((today() + dt.timedelta(days=14)).isoformat(),))],
         'food_expiring_3_days': [pantry_row(r) for r in con.execute(
             "SELECT * FROM pantry WHERE status = 'in' AND expires_on <= ? ORDER BY expires_on",
             ((today() + dt.timedelta(days=3)).isoformat(),))],
         'shopping': [shop_row(r) for r in con.execute("SELECT * FROM shopping WHERE status = 'need' ORDER BY added_at")],
         'balances': [balance(con, r['key']) for r in con.execute('SELECT key FROM groups_')],
         'pantry_in_stock': con.execute("SELECT count(*) FROM pantry WHERE status = 'in'").fetchone()[0]})


def cmd_config(con, a):
    c = conf()
    if a.key and a.value is not None:
        c[a.key] = None if a.value == 'none' else a.value
        c = {k: v for k, v in c.items() if v is not None}
        os.makedirs(DATA, exist_ok=True)
        json.dump(c, open(CONF, 'w'), indent=2)
    out({a.key: c.get(a.key)} if a.key and a.value is None else c)


# ---------- Notion mirror (one-way: house.db is the source of truth) ----------

NOTION_CONF = os.path.join(DATA, 'notion.json')
NOTION_VERSION = '2022-06-28'


def rt(text):
    text = str(text or '')[:1990]
    return [{'type': 'text', 'text': {'content': text}}] if text else []


def sel(v):
    return {'select': {'name': str(v)[:100].replace(',', ' ')} if v else None}


def date(v):
    return {'date': {'start': v[:10]} if v else None}


def num(c):
    return {'number': None if c is None else c / 100}


TABLES = {  # table: (Notion title, emoji, schema, props(row, ppl), archived(row))
    'pantry': ('Pantry', '🥫', {'Item': {'title': {}}, 'Where': {'select': {}}, 'Expires': {'date': {}},
                                'Estimated': {'checkbox': {}}, 'Qty': {'rich_text': {}}, 'Status': {'select': {}},
                                'Source': {'rich_text': {}}, 'Local ID': {'number': {}}},
               lambda r, p: {'Item': {'title': rt(r['name'])}, 'Where': sel(r['location']), 'Expires': date(r['expires_on']),
                             'Estimated': {'checkbox': bool(r['expiry_estimated'])},
                             'Qty': {'rich_text': rt(' '.join(str(x) for x in (r['qty'], r['unit']) if x is not None))},
                             'Status': sel(r['status']), 'Source': {'rich_text': rt(r['source'])},
                             'Local ID': {'number': r['id']}},
               lambda r: r['status'] != 'in'),
    'shopping': ('Shopping list', '🛒', {'Item': {'title': {}}, 'Qty': {'rich_text': {}}, 'Note': {'rich_text': {}},
                                         'Added by': {'select': {}}, 'Status': {'select': {}}, 'Local ID': {'number': {}}},
                 lambda r, p: {'Item': {'title': rt(r['item'])}, 'Qty': {'rich_text': rt(r['qty'])},
                               'Note': {'rich_text': rt(r['note'])}, 'Added by': sel(p.get(r['added_by'])),
                               'Status': sel(r['status']), 'Local ID': {'number': r['id']}},
                 lambda r: r['status'] == 'dropped'),
    'bills': ('Bills', '🧾', {'Bill': {'title': {}}, 'Provider': {'rich_text': {}}, 'Amount': {'number': {'format': 'dollar'}},
                              'Due': {'date': {}}, 'Every': {'select': {}}, 'Group': {'select': {}}, 'Status': {'select': {}},
                              'Paid': {'date': {}}, 'Paid by': {'select': {}}, 'Autopay': {'checkbox': {}},
                              'Local ID': {'number': {}}},
              lambda r, p: {'Bill': {'title': rt(r['name'])}, 'Provider': {'rich_text': rt(r['provider'])},
                            'Amount': num(r['amount_cents']), 'Due': date(r['due_on']), 'Every': sel(r['every']),
                            'Group': sel(r['grp']), 'Status': sel(r['status']), 'Paid': date(r['paid_at']),
                            'Paid by': sel(p.get(r['paid_by'])), 'Autopay': {'checkbox': bool(r['autopay'])},
                            'Local ID': {'number': r['id']}},
              lambda r: r['status'] == 'dropped'),
    'dishes': ('Dishes', '🍳', {'Dish': {'title': {}}, 'Ingredients': {'rich_text': {}}, 'Optional': {'rich_text': {}},
                                'Tags': {'multi_select': {}}, 'Minutes': {'number': {}}, 'Times cooked': {'number': {}},
                                'Last cooked': {'date': {}}, 'Rating': {'number': {}}, 'Recipe': {'url': {}},
                                'Note': {'rich_text': {}}, 'Local ID': {'number': {}}},
               lambda r, p: dish_props(r),
               lambda r: r['status'] != 'active'),
    'expenses': ('Shared money', '💸', {'Note': {'title': {}}, 'Amount': {'number': {'format': 'dollar'}},
                                        'Paid by': {'select': {}}, 'To': {'select': {}}, 'Kind': {'select': {}},
                                        'Group': {'select': {}}, 'Shares': {'rich_text': {}}, 'Date': {'date': {}},
                                        'Local ID': {'number': {}}},
                 lambda r, p: {'Note': {'title': rt(r['note'] or r['kind'])}, 'Amount': num(r['amount_cents']),
                               'Paid by': sel(p.get(r['paid_by'])), 'To': sel(p.get(r['to_person'])), 'Kind': sel(r['kind']),
                               'Group': sel(r['grp']), 'Date': date(r['ts']),
                               'Shares': {'rich_text': rt(', '.join(f'{p.get(k, k)} {money(v)}' for k, v in
                                                                    json.loads(r['shares'] or '{}').items()))},
                               'Local ID': {'number': r['id']}},
                 lambda r: bool(r['voided_at'])),
}


def dish_props(r):
    con = db()
    ck = con.execute('SELECT count(*) n, max(date) last, avg(rating) avg FROM cooked WHERE dish_id = ?', (r['id'],)).fetchone()
    return {'Dish': {'title': rt(r['name'])}, 'Ingredients': {'rich_text': rt(r['ingredients'])},
            'Optional': {'rich_text': rt(r['optional'])},
            'Tags': {'multi_select': [{'name': t[:100]} for t in split_list(r['tags'])][:20]},
            'Minutes': {'number': r['minutes']}, 'Times cooked': {'number': ck['n']}, 'Last cooked': date(ck['last']),
            'Rating': {'number': ck['avg'] and round(ck['avg'], 1)},
            'Recipe': {'url': r['url'] if r['url'] and r['url'].startswith('http') else None},
            'Note': {'rich_text': rt(r['note'])}, 'Local ID': {'number': r['id']}}


def dish_page(con, r, nid):
    """The cookbook page: ingredients and method as the page body. Rewritten only when they change."""
    def block(kind, text):
        return {'object': 'block', 'type': kind, kind: {'rich_text': rt(text)}}
    blocks = [block('heading_2', 'Ingredients')] + [block('bulleted_list_item', i) for i in split_list(r['ingredients'])]
    blocks += [block('bulleted_list_item', f'{i} (optional)') for i in split_list(r['optional'])]
    if steps_of(r):
        blocks += [block('heading_2', 'Method')] + [block('numbered_list_item', x) for x in steps_of(r)]
    if r['note']:
        blocks += [block('quote', r['note'])]
    digest = __import__('hashlib').sha1(json.dumps(blocks).encode()).hexdigest()
    if digest == r['notion_body']:
        return
    for b in notion('GET', f'blocks/{nid}/children?page_size=100').get('results', []):
        notion('DELETE', f"blocks/{b['id']}")
    notion('PATCH', f'blocks/{nid}/children', {'children': blocks[:100]})
    con.execute('UPDATE dishes SET notion_body = ? WHERE id = ?', (digest, r['id']))


@__import__('functools').lru_cache(maxsize=None)
def notion_key():
    """From the environment, else hq-auth (house's grant for the notion service, ~/.config/hq/auth.json)."""
    if os.environ.get('NOTION_API_KEY'):
        return os.environ['NOTION_API_KEY']
    r = subprocess.run([os.path.join(HQ, 'bin', 'hq-auth'), 'get', '--for', 'house', 'notion', 'NOTION_API_KEY'],
                       capture_output=True, text=True)
    return r.stdout.strip() or None


def notion(method, path, body=None):
    import time
    for attempt in range(4):
        req = urllib.request.Request('https://api.notion.com/v1/' + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': 'Bearer ' + notion_key(), 'Notion-Version': NOTION_VERSION,
                                              'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                time.sleep(0.35)  # Notion allows ~3 requests/s
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < 3:
                time.sleep(float(e.headers.get('Retry-After') or 2 ** attempt))
                continue
            raise RuntimeError(f'Notion {e.code}: {e.read().decode(errors="replace")[:300]}')


def notion_dbs(parent=None):
    nc = json.load(open(NOTION_CONF)) if os.path.exists(NOTION_CONF) else {}
    parent = parent or nc.get('parent')
    if not parent:
        return None
    nc['parent'] = parent
    for table, (title, emoji, schema, _, _) in TABLES.items():
        if not nc.get(table):
            d = notion('POST', 'databases', {'parent': {'type': 'page_id', 'page_id': parent}, 'is_inline': True,
                                             'title': rt(title), 'icon': {'type': 'emoji', 'emoji': emoji},
                                             'properties': schema})
            nc[table] = {'id': d['id'], 'url': d.get('url')}
            json.dump(nc, open(NOTION_CONF, 'w'), indent=2)
    return nc


def notion_sync(con, parent=None, everything=False):
    if not notion_key():
        return {'skipped': 'no NOTION_API_KEY (grant: hq-auth grant house notion <profile>)'}
    nc = notion_dbs(parent)
    if not nc:
        return {'skipped': 'no Notion page yet: run `house notion --parent PAGE_URL` once'}
    ppl, res = people(con), {}
    for table, (_, _, _, props, archived) in TABLES.items():
        stamp = 'coalesce(updated_at, added_at)' if table != 'expenses' else 'coalesce(updated_at, ts)'
        where = '1=1' if everything else f'notion_synced_at IS NULL OR {stamp} > notion_synced_at'
        done, failed = 0, []
        for r in con.execute(f'SELECT * FROM {table} WHERE {where} ORDER BY id').fetchall():
            body = {'properties': props(r, ppl)}
            if table == 'dishes' and (r['photo'] or '').startswith('http'):
                body['cover'] = {'type': 'external', 'external': {'url': r['photo']}}
            try:
                if r['notion_id']:
                    notion('PATCH', f"pages/{r['notion_id']}", dict(body, archived=archived(r)))
                    nid = r['notion_id']
                elif archived(r):
                    nid = None
                else:
                    nid = notion('POST', 'pages', dict(body, parent={'database_id': nc[table]['id']}))['id']
                if table == 'dishes' and nid and not archived(r):
                    dish_page(con, r, nid)
            except RuntimeError as e:
                failed.append({'id': r['id'], 'error': str(e)[:200]})
                continue
            con.execute(f'UPDATE {table} SET notion_id = ?, notion_synced_at = ? WHERE id = ?', (nid, now(), r['id']))
            con.commit()
            done += 1
        res[table] = {'synced': done, 'failed': failed} if failed else done
    return res


def auto_sync(con):
    """After any write: mirror to Notion if it's set up. Never fails the command."""
    if not os.path.exists(NOTION_CONF) or os.environ.get('HOUSE_NO_SYNC'):
        return
    try:
        res = notion_sync(con)
        bad = [t for t, v in res.items() if isinstance(v, dict) and v.get('failed')]
        if bad:
            print(f"house: Notion sync failed for some {', '.join(bad)} rows; run `house notion` to retry", file=sys.stderr)
    except Exception as e:  # offline, token revoked…: the local save already happened
        print(f'house: Notion sync skipped ({e})', file=sys.stderr)


def cmd_notion(con, a):
    if a.parent:
        m = re.findall(r'[0-9a-f]{32}', a.parent.replace('-', '').lower())
        a.parent = m[-1] if m else die('give the page URL or its 32-character ID')
    res = notion_sync(con, a.parent, a.all)
    if os.path.exists(NOTION_CONF):
        res['databases'] = {t: v['url'] for t, v in json.load(open(NOTION_CONF)).items() if isinstance(v, dict)}
    out(res)


# ---------- CLI ----------

def main():
    p = argparse.ArgumentParser(prog='house.py', description=__doc__.split('\n')[0])
    sub = p.add_subparsers(dest='cmd', required=True)
    writes = set()

    def cmd(name, fn, parent=sub, write=False, **kw):
        s = parent.add_parser(name, **kw)
        s.set_defaults(fn=fn)
        if write:
            writes.add(fn)
        return s

    cmd('status', cmd_status)
    cmd('people', cmd_people)
    s = cmd('person', None).add_subparsers(dest='sub', required=True)
    x = cmd('add', cmd_person_add, s)
    x.add_argument('key'), x.add_argument('name')
    s = cmd('group', None).add_subparsers(dest='sub', required=True)
    x = cmd('add', cmd_group_add, s)
    x.add_argument('key'), x.add_argument('--members', required=True), x.add_argument('--name')

    s = cmd('pantry', None).add_subparsers(dest='sub', required=True)
    x = cmd('add', cmd_pantry_add, s, write=True)
    x.add_argument('name')
    for f in ('--unit', '--where', '--expires', '--source', '--note'):
        x.add_argument(f)
    x.add_argument('--qty', type=float), x.add_argument('--estimated', action='store_true')
    x = cmd('import', cmd_pantry_import, s, write=True)
    x.add_argument('file'), x.add_argument('--source')
    x = cmd('list', cmd_pantry_list, s)
    x.add_argument('--expiring', type=int), x.add_argument('--where'), x.add_argument('--all', action='store_true')
    for name, status in (('use', 'used'), ('toss', 'tossed')):
        x = cmd(name, lambda con, a, st=status: pantry_set_status(con, a.ids, st), s, write=True)
        x.add_argument('ids', nargs='+', type=int)
        writes.add(x.get_default('fn'))
    x = cmd('edit', cmd_pantry_edit, s, write=True)
    x.add_argument('id', type=int)
    for f in ('--name', '--unit', '--where', '--expires', '--note'):
        x.add_argument(f)
    x.add_argument('--qty', type=float), x.add_argument('--estimated', action='store_true')

    s = cmd('shop', None).add_subparsers(dest='sub', required=True)
    x = cmd('add', cmd_shop_add, s, write=True)
    x.add_argument('item'), x.add_argument('--qty'), x.add_argument('--note'), x.add_argument('--by')
    x = cmd('list', cmd_shop_list, s)
    x.add_argument('--all', action='store_true')
    for name, status in (('got', 'got'), ('drop', 'dropped')):
        x = cmd(name, lambda con, a, st=status: shop_set(con, a.refs, st), s)
        x.add_argument('refs', nargs='+')
        writes.add(x.get_default('fn'))

    x = cmd('spend', cmd_spend, write=True)
    x.add_argument('amount')
    x.add_argument('--by', required=True)
    for f in ('--group', '--among', '--split', '--note', '--date'):
        x.add_argument(f)
    x = cmd('settle', cmd_settle, write=True)
    x.add_argument('amount'), x.add_argument('--from', dest='frm', required=True), x.add_argument('--to', required=True)
    x.add_argument('--group'), x.add_argument('--note')
    x = cmd('balance', cmd_balance)
    x.add_argument('--group')
    x = cmd('history', cmd_history)
    x.add_argument('--group'), x.add_argument('--limit', type=int, default=20)
    x = cmd('undo', cmd_undo, write=True)
    x.add_argument('--group'), x.add_argument('--id', type=int)

    s = cmd('bill', None).add_subparsers(dest='sub', required=True)
    x = cmd('add', cmd_bill_add, s, write=True)
    x.add_argument('name'), x.add_argument('--due', required=True)
    for f in ('--amount', '--every', '--provider', '--group', '--note', '--ref', '--source'):
        x.add_argument(f)
    x.add_argument('--autopay', action='store_true')
    x = cmd('ingest', cmd_bill_ingest, s, write=True)
    x.add_argument('file'), x.add_argument('--source')
    x = cmd('list', cmd_bill_list, s)
    x.add_argument('--days', type=int), x.add_argument('--all', action='store_true')
    x = cmd('paid', cmd_bill_paid, s, write=True)
    x.add_argument('id', type=int), x.add_argument('--by'), x.add_argument('--amount'), x.add_argument('--no-log', action='store_true')
    x = cmd('edit', cmd_bill_edit, s, write=True)
    x.add_argument('id', type=int)
    for f in ('--amount', '--due', '--every', '--group', '--name', '--provider', '--note'):
        x.add_argument(f)
    x.add_argument('--autopay', choices=['yes', 'no'])
    x = cmd('drop', cmd_bill_drop, s, write=True)
    x.add_argument('id', type=int)

    s = cmd('dish', None).add_subparsers(dest='sub', required=True)
    for name, fn in (('add', cmd_dish_add), ('edit', cmd_dish_edit)):
        x = cmd(name, fn, s, write=True)
        x.add_argument('name' if name == 'add' else 'dish')
        for f in ('--ingredients', '--optional', '--tags', '--url', '--note', '--steps', '--photo'):
            x.add_argument(f)
        x.add_argument('--minutes', type=int)
        if name == 'add':
            x.add_argument('--by'), x.add_argument('--cooked', nargs='?', const='', default=None)
            x.add_argument('--rating', type=int)
        else:
            x.add_argument('--rename')
    x = cmd('cooked', cmd_dish_cooked, s, write=True)
    x.add_argument('dish'), x.add_argument('--date'), x.add_argument('--by'), x.add_argument('--rating', type=int)
    x.add_argument('--note')
    x = cmd('list', cmd_dish_list, s)
    x.add_argument('--tag'), x.add_argument('--search'), x.add_argument('--tried', action='store_true')
    x.add_argument('--to-try', action='store_true')
    x = cmd('show', cmd_dish_show, s)
    x.add_argument('dish')
    x = cmd('drop', cmd_dish_drop, s, write=True)
    x.add_argument('dish')
    s = cmd('cook', None).add_subparsers(dest='sub', required=True)
    x = cmd('suggest', cmd_cook_suggest, s)
    x.add_argument('--limit', type=int, default=5), x.add_argument('--tag')
    x = cmd('need', cmd_cook_need, s, write=True)
    x.add_argument('dish'), x.add_argument('--add', action='store_true')

    x = cmd('remind', cmd_remind)
    x.add_argument('--bill-days', type=int, default=3), x.add_argument('--food-days', type=int, default=2)
    x.add_argument('--send', action='store_true')
    x = cmd('config', cmd_config)
    x.add_argument('key', nargs='?'), x.add_argument('value', nargs='?')
    x = cmd('notion', cmd_notion)
    x.add_argument('--parent'), x.add_argument('--all', action='store_true')

    a = p.parse_args()
    con = db()
    a.fn(con, a)
    if a.fn in writes:
        auto_sync(con)


if __name__ == '__main__':
    main()
