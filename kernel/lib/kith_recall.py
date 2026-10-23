"""kith_recall — the local memory index (SQLite FTS5) and the recall query over it (docs/memory-context.md).

The index is this Mac's own derived state, $KITH_MACHINE/index/memory.db (folder 0700, file 0600): never in git or the
cloud, rebuildable any time from the notes. Each row carries the audience of its note; a query puts the caller's visible
audiences in the WHERE next to the FTS match, so a row the caller may not see cannot come back. Rows have a `kind`
(note | summary | trajectory); this version fills `note` only, summaries and trajectory slot in later.
"""
import contextlib, fcntl, hashlib, json, os, re, sqlite3, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from kith_paths import paths  # noqa: E402
import kith_facets  # noqa: E402

VERSION = 1
MAX_FILE = 1_000_000
MAX_PASSAGE = 1500
SNIPPET = 200
SCHEMA = """
CREATE TABLE index_rows(id TEXT PRIMARY KEY, kind TEXT, agent TEXT, audience TEXT, room TEXT, projects_json TEXT,
  thread_id TEXT, source_path TEXT, entry_id TEXT, text TEXT, updated_at REAL);
CREATE INDEX rows_audience ON index_rows(audience, agent);
CREATE INDEX rows_source ON index_rows(source_path);
CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='unicode61');
CREATE TABLE sources(path TEXT PRIMARY KEY, mtime_ns INTEGER, size INTEGER);
"""


def index_dir():
    return paths()['KITH_MACHINE'] / 'index'


def db_path():
    return index_dir() / 'memory.db'


def _private_dir():
    d = index_dir()
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(d, 0o700)
    return d


# ---- sources: the files that become rows. An explicit list: only memory/, user.md and people/ are read, so the
# secrets folder, serve token and device identity are never indexed.

def sources():
    """(path, agent, rel, kind) for every note file: agents' memory/**.md, then user.md and people/<id>.md."""
    p = paths()
    state = p['KITH_STATE']
    homes = {}
    for root in (p['KITH_AGENTS'], state / 'agents'):
        if root.is_dir() and not root.is_symlink():
            for d in sorted(root.iterdir()):
                if d.is_dir() and kith_facets.ID.match(d.name):
                    homes.setdefault(d.name, d)
    for name, home in homes.items():
        mem = home / 'memory'
        if mem.is_dir():
            for f in sorted(mem.rglob('*.md')):
                yield f, name, f.relative_to(mem).as_posix(), 'agent'
    if (state / 'user.md').is_file():
        yield state / 'user.md', '', 'user.md', 'user'
    people = state / 'people'
    if people.is_dir():
        for f in sorted(people.glob('*.md')):
            yield f, '', f.name, 'person'


def passages(text):
    """(first line number, text) per heading or paragraph."""
    chunk, start = [], 1
    for i, line in enumerate(text.splitlines(), 1):
        if (not line.strip() or line.startswith('#')) and any(c.strip() for c in chunk):
            yield start, '\n'.join(chunk).strip()
            chunk = []
        if not chunk:
            start = i
        if line.strip() or chunk:
            chunk.append(line)
    if any(c.strip() for c in chunk):
        yield start, '\n'.join(chunk).strip()


def rows_of(path, agent, rel, kind):
    """The index rows of one file, or [] when it can't be read or isn't a plain file."""
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE:
            return []
        text = path.read_text(errors='replace')
    except OSError:
        return []
    if kind == 'agent':
        f = kith_facets.facets_for(rel, agent, text)
    else:
        f = kith_facets.state_file_facets(kind, path.stem if kind == 'person' else '', text)
    body = kith_facets.split_frontmatter(text)[1]
    skipped = len(text.split('\n')) - len(body.split('\n'))   # frontmatter lines, so entry ids stay file line numbers
    out = []
    for line, chunk in passages(body):
        for k in range(0, len(chunk), MAX_PASSAGE):
            rid = hashlib.sha1(('%s:%d:%d' % (path, line, k)).encode()).hexdigest()[:20]
            out.append((rid, 'note', agent, f['audience'], f['room'], json.dumps(f['projects']), f['thread'],
                        str(path), str(line + skipped), chunk[k:k + MAX_PASSAGE]))
    return out


def drop(db, path):
    db.execute('DELETE FROM fts WHERE rowid IN (SELECT rowid FROM index_rows WHERE source_path=?)', (path,))
    db.execute('DELETE FROM index_rows WHERE source_path=?', (path,))
    db.execute('DELETE FROM sources WHERE path=?', (path,))


def put(db, path, agent, rel, kind):
    drop(db, str(path))
    now = time.time()
    for r in rows_of(path, agent, rel, kind):
        cur = db.execute('INSERT OR REPLACE INTO index_rows VALUES(?,?,?,?,?,?,?,?,?,?,?)', (*r, now))
        db.execute('INSERT INTO fts(rowid, text) VALUES(?,?)', (cur.lastrowid, r[9]))
    with contextlib.suppress(OSError):
        st = path.stat()
        db.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?)', (str(path), st.st_mtime_ns, st.st_size))


def _connect(path):
    db = sqlite3.connect(str(path), timeout=10)
    db.execute('PRAGMA busy_timeout=10000')
    return db


@contextlib.contextmanager
def _lock():
    fd = os.open(str(_private_dir() / '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def rebuild():
    """Build everything into memory.db.new, then rename it over memory.db in one step: a reader keeps the old file
    until it is done and never sees half an index. Two rebuilds take turns on a lock. Returns the row count."""
    d = _private_dir()
    new = d / 'memory.db.new'
    with _lock():
        old_umask = os.umask(0o077)
        try:
            new.unlink(missing_ok=True)
            db = _connect(new)
            db.executescript(SCHEMA)
            db.execute('PRAGMA user_version=%d' % VERSION)
            for src in sources():
                put(db, *src)
            db.commit()
            n = db.execute('SELECT count(*) FROM index_rows').fetchone()[0]
            db.close()
            os.chmod(new, 0o600)
            os.replace(new, db_path())
        finally:
            os.umask(old_umask)
    return n


def update(db):
    """Bring the index up to date by path, mtime and size: re-read changed files, add new ones, drop vanished ones."""
    known = {p: (m, s) for p, m, s in db.execute('SELECT path, mtime_ns, size FROM sources')}
    seen = set()
    for src in sources():
        path = str(src[0])
        seen.add(path)
        try:
            st = src[0].stat()
        except OSError:
            continue
        if known.get(path) != (st.st_mtime_ns, st.st_size):
            put(db, *src)
    for path in set(known) - seen:
        drop(db, path)
    db.commit()


def open_index():
    """A connection to an up-to-date index: built on first use, rebuilt when its schema is old or the file is corrupt."""
    for attempt in (0, 1):
        try:
            if not db_path().exists():
                rebuild()
            db = _connect(db_path())
            if db.execute('PRAGMA user_version').fetchone()[0] != VERSION:
                db.close()
                rebuild()
                db = _connect(db_path())
            with _lock():
                update(db)
            return db
        except sqlite3.DatabaseError:
            if attempt:
                raise
            with contextlib.suppress(OSError):
                db_path().unlink()


# ---- who is asking

def _auth(*args):
    r = subprocess.run([str(Path(__file__).resolve().parent.parent / 'bin' / 'kith-auth'), *args],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except ValueError:
        return None


def bot_root(people, bot, depth=8):
    """The root owner of a bot guest from `kith-auth people --json` ({id: {bot_of, ...}}, or under "people"), or None
    when the chain is broken: a bot whose parent is missing has no access."""
    if isinstance(people, dict) and isinstance(people.get('people'), dict):
        people = people['people']
    if not isinstance(people, dict):
        return None
    cur = bot
    for _ in range(depth):
        row = people.get(cur)
        if not isinstance(row, dict):
            return None
        parent = row.get('bot_of')
        if not parent:
            return cur if cur != bot else None
        cur = parent
    return None


def caller():
    """The asker's visible set, cut down to what everyone in a group room may see when KITH_ROOM names one (the answer is
    read by all of them). No member list is resolvable yet, so a group room gets `shared` + its own notes only: fail closed.
    A 1:1 room (1:1:<agent>:<person>) has one reader, the asker, so it changes nothing."""
    who = _caller()
    room = os.environ.get('KITH_ROOM') or ''
    if not room or room.startswith('1:1:') or who['audiences'] == []:
        return who
    if not kith_facets.ID.match(room):
        return {**who, 'audiences': []}
    return {**who, 'audiences': ['shared', 'room:' + room]}


def _caller():
    """{who, agent, audiences}: from the environment only. audiences None = everything of the agent (the owner); a list =
    the exact audience values the caller may see; [] = nothing (fails closed)."""
    agent = os.environ.get('KITH_AGENT') or ''
    person = os.environ.get('KITH_PERSON') or ''
    nobody = {'who': person or '-', 'agent': agent, 'audiences': []}
    if not person:
        return {'who': 'owner', 'agent': agent, 'audiences': None}
    if re.fullmatch(r'bot-[0-9a-f]+', person):
        # guest level of the root owner: shared craft only, never the owner's or a person's. An older kith-auth has no
        # `people --json`: no answer, no access.
        return {**nobody, 'audiences': ['shared']} if agent and bot_root(_auth('people', '--json'), person) else nobody
    r = _auth('resolve', agent or '-', '--person', person)
    pid = (r or {}).get('person') or ''
    if not r or not r.get('allowed') or not agent or not re.fullmatch(r'[a-z][a-z0-9-]*', pid):
        return nobody
    if r.get('owner'):
        return {'who': 'owner', 'agent': agent, 'audiences': None}
    rooms = [x for x in r.get('rooms', []) if isinstance(x, str) and kith_facets.ID.match(x)]
    return {**nobody, 'who': pid, 'audiences': ['shared', 'person:' + pid, *('room:' + x for x in rooms)]}


# ---- the query

def fts_query(words):
    if re.search(r'["*]|\b(AND|OR|NOT|NEAR)\b', words):
        return words
    return ' '.join('"%s"' % w.replace('"', '""') for w in words.split())


def recall(db, who, query, project='', room='', thread='', tier='2', limit=8):
    """Hits as dicts. The audience and agent conditions come first in the WHERE; the flags only add to it."""
    if who['audiences'] == []:
        return []
    where, args = [], []
    if who['audiences'] is not None:
        where.append('r.audience IN (%s)' % ','.join('?' * len(who['audiences'])))
        args += who['audiences']
    if who['agent']:
        where.append("r.agent IN (?, '')")
        args.append(who['agent'])
    kinds = {'2': ('note', 'summary'), '3': ('trajectory',), 'all': ('note', 'summary', 'trajectory')}[tier]
    where.append('r.kind IN (%s)' % ','.join('?' * len(kinds)))
    args += kinds
    for cond, val in (('r.room = ?', room), ('r.thread_id = ?', thread),
                      ('EXISTS (SELECT 1 FROM json_each(r.projects_json) WHERE value = ?)', project)):
        if val:
            where.append(cond)
            args.append(val)
    base = ' AND '.join(where)
    cols = 'r.kind, r.agent, r.audience, r.room, r.projects_json, r.source_path, r.entry_id, r.thread_id, r.text'
    try:
        rows = db.execute("SELECT %s, snippet(fts, 0, '', '', '...', 40) FROM index_rows r JOIN fts ON fts.rowid = r.rowid "
                          'WHERE %s AND fts MATCH ? ORDER BY bm25(fts) LIMIT ?' % (cols, base),
                          (*args, fts_query(query), limit)).fetchall()
    except sqlite3.OperationalError:   # FTS syntax the words broke
        rows = []
    if not rows:   # text FTS doesn't split into words (Chinese, say): plain substring, same conditions
        like = '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        rows = [(*r, r[8]) for r in db.execute(
            "SELECT %s FROM index_rows r WHERE %s AND r.text LIKE ? ESCAPE '\\' LIMIT ?" % (cols, base),
            (*args, like, limit)).fetchall()]
    return [{'kind': kind, 'tier': 3 if kind == 'trajectory' else 2, 'agent': agent, 'audience': aud, 'room': rm,
             'projects': json.loads(pj or '[]'),
             'link': '%s#L%s' % (src, entry) if kind == 'note' else 'kith://thread/%s#entry=%s' % (tid, entry),
             'snippet': ' '.join(snip.split())[:SNIPPET]}
            for kind, agent, aud, rm, pj, src, entry, tid, text, snip in rows]


def frame(h):
    """One hit as data: the text can't close the tag, and attributes can't break out of their quotes."""
    esc = lambda v: str(v).replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')
    attrs = ' '.join('%s="%s"' % (k, esc(v)) for k, v in (
        ('source', h['kind']), ('tier', h['tier']), ('audience', h['audience']), ('room', h['room']),
        ('projects', ','.join(h['projects'])), ('link', h['link'])))
    return '<recalled %s>\n%s\n</recalled>' % (attrs, h['snippet'].replace('</recalled', '&lt;/recalled'))
