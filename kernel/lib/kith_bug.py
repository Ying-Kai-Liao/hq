"""kith_bug — the redacted path of a bug report, shared by `kith bug` and kith-permit's report_bug tool.

A draft is built from a title and details with every secret and personal detail scrubbed (kith_redact). Nothing is
filed until someone clearly says yes to exactly that draft text: a y/N at a terminal, or an approval card whose input
carries the draft. No yes, an error, a timeout or no way to ask: nothing is filed, the draft is kept under
<state>/bugs/drafts and a prefilled issues/new URL is the way out. A draft that was filed records its issue URL and is
never filed twice.
"""
import hashlib, json, os, platform, subprocess, sys, urllib.parse
from pathlib import Path

from kith_paths import KERNEL, paths
from kith_redact import redactor

REPO = 'Ying-Kai-Liao/kith'
CARD_TOOL = 'mcp__kithpermit__report_bug'    # mcp__ tools run code: the host always sends their card to the owner
MAX_URL = 7000
MAX_TEXT = 6000


def repo(env=os.environ):
    return env.get('KITH_BUG_REPO') or REPO


def is_owner(env=os.environ):
    """The owner's run: KITH_OWNER says so (KITH_PERSON can name the owner too); a terminal run has neither."""
    if env.get('KITH_OWNER') in ('0', '1'):
        return env['KITH_OWNER'] == '1'
    return not env.get('KITH_PERSON')


def state_dir(env=os.environ):
    return Path(env.get('KITH_STATE') or paths()['KITH_STATE'])


def _git(args, cwd):
    try:
        return subprocess.run(['git', '-C', str(cwd)] + args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None


def ensure_untracked(target):
    """Raises if `target` (a path under the state folder) could be committed. Ignored by git, or outside any work tree."""
    probe = Path(target)
    while not probe.exists():
        probe = probe.parent
    inside = _git(['rev-parse', '--is-inside-work-tree'], probe if probe.is_dir() else probe.parent)
    if inside is None:    # no git here: a .git folder up the path is as much as can be told
        if any((d / '.git').exists() for d in [probe, *probe.parents]):
            raise RuntimeError('cannot tell whether %s is ignored by git (git is missing)' % target)
        return
    if inside.returncode != 0:
        return            # not in a work tree: nothing can commit it
    r = _git(['check-ignore', '-q', str(target)], probe if probe.is_dir() else probe.parent)
    if r is None or r.returncode != 0:
        raise RuntimeError('%s is not ignored by git and could be committed; refusing to write a bug record there' % target)


def private_dir(path):
    """mkdir -p with 0700 and no window: the umask is 077 while it is made."""
    old = os.umask(0o077)
    try:
        Path(path).mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path, 0o700)
    finally:
        os.umask(old)


def write_private(path, data):
    old = os.umask(0o077)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb' if isinstance(data, bytes) else 'w') as f:
            f.write(data)
        os.chmod(path, 0o600)
    finally:
        os.umask(old)


def kith_version():
    r = _git(['rev-parse', '--short', 'HEAD'], KERNEL)
    return r.stdout.strip() if r and r.returncode == 0 and r.stdout.strip() else 'unknown'


def build_draft(title, details, who, env=os.environ):
    """{repo, title, body, labels}: scrubbed. `who` is 'user' or 'agent' (the from: label)."""
    scrub = redactor(env)
    title = scrub(' '.join(str(title).split()))[:200] or 'Bug report'
    details = scrub(str(details or '').strip())[:MAX_TEXT] or '(no details)'
    agent = scrub(env.get('KITH_AGENT') or 'unknown')
    body = '\n'.join(['## What happened', '', details, '', '## Environment', '',
                      '- kith: %s' % kith_version(),
                      '- agent: %s' % agent,
                      '- os: %s %s' % (platform.system(), platform.release()),
                      '- harness: %s' % (env.get('KITH_HARNESS') or 'claude'),
                      '', '_Filed with `kith bug` after approval; secrets and personal details were scrubbed._'])
    return {'repo': repo(env), 'title': title, 'body': body, 'labels': ['bug', 'from:' + who]}


def draft_text(d):
    return 'Repo: %s\nLabels: %s\nTitle: %s\n\n%s' % (d['repo'], ', '.join(d['labels']), d['title'], d['body'])


def draft_id(d):
    return hashlib.sha256(draft_text(d).encode()).hexdigest()[:12]


def _gh(args, env, timeout=60, stdin=None):
    try:
        return subprocess.run(['gh'] + args, capture_output=True, text=True, timeout=timeout, input=stdin, env=dict(env))
    except (OSError, subprocess.SubprocessError):
        return None


def similar(d, env=os.environ):
    """Open issues whose title matches: [{number, title, url}]; empty when gh can't say."""
    r = _gh(['issue', 'list', '--repo', d['repo'], '--state', 'open', '--search', d['title'] + ' in:title',
             '--json', 'number,title,url', '--limit', '5'], env, timeout=30)
    try:
        out = json.loads(r.stdout) if r and r.returncode == 0 else []
        return [{k: x.get(k) for k in ('number', 'title', 'url')} for x in out if isinstance(x, dict)]
    except ValueError:
        return []


def prefilled_url(d):
    body = d['body']
    while True:
        url = 'https://github.com/%s/issues/new?%s' % (d['repo'], urllib.parse.urlencode(
            {'title': d['title'], 'body': body, 'labels': 'bug'}, quote_via=urllib.parse.quote))
        if len(url) <= MAX_URL or len(body) < 200:
            return url
        body = body[:len(body) * 3 // 4] + '\n(cut)'


def _store(d, env):
    """The kept copy of a draft: <state>/bugs/drafts/<id>.json. None when it can't be kept safely (never fatal)."""
    try:
        base = state_dir(env) / 'bugs' / 'drafts'
        ensure_untracked(base / 'x.json')
        private_dir(state_dir(env) / 'bugs')
        private_dir(base)
        return base / (draft_id(d) + '.json')
    except (OSError, RuntimeError):
        return None


def keep(d, env=os.environ):
    f = _store(d, env)
    if f is not None and not f.exists():
        write_private(f, json.dumps(d, indent=1))
    return f


def filed_url(d, env=os.environ):
    f = _store(d, env)
    try:
        return json.loads(f.read_text()).get('issue') if f is not None and f.exists() else None
    except (OSError, ValueError):
        return None


def create_issue(d, env=os.environ):
    """(url, None) when gh filed it, else (None, why). One create; the labels are dropped once if the repo lacks them."""
    for labels in (d['labels'], ['bug']):
        args = ['issue', 'create', '--repo', d['repo'], '--title', d['title'], '--body-file', '-']
        for lab in labels:
            args += ['--label', lab]
        r = _gh(args, env, stdin=d['body'])
        if r is None:
            return None, 'gh is not installed'
        if r.returncode == 0:
            lines = r.stdout.strip().splitlines()
            return (lines[-1] if lines else ''), None
        if 'label' not in (r.stderr or '').lower():
            return None, 'gh could not file it (%s)' % ((r.stderr or '').strip().splitlines() or ['not logged in?'])[0][:200]
    return None, 'gh could not file it'


def card_input(d, matches):
    return {'repo': d['repo'], 'title': d['title'], 'body': d['body'], 'labels': d['labels'], 'similar': matches,
            'draft': draft_text(d)}


def tty_yes(d, matches):
    sys.stdout.write(draft_text(d) + '\n')
    for m in matches:
        sys.stdout.write('Similar open issue: #%s %s %s\n' % (m['number'], m['title'], m['url']))
    sys.stdout.write('File this as a public issue on %s? [y/N] ' % d['repo'])
    sys.stdout.flush()
    return sys.stdin.readline().strip().lower() in ('y', 'yes')


def file_draft(d, decide, env=os.environ, interactive=False):
    """The whole redacted path for one draft. Returns (status, text): status is 'filed', 'already', 'kept'.

    `decide(tool, input)` is kith-permit's decide(): the card. Only a clear allow files; everything else keeps the draft."""
    keep(d, env)
    done = filed_url(d, env)
    if done:
        return 'already', 'Already filed: %s' % done
    matches = similar(d, env)
    yes = False
    if interactive:
        yes = tty_yes(d, matches)
    else:
        try:
            yes = decide(CARD_TOOL, card_input(d, matches)).get('behavior') == 'allow'
        except Exception:    # noqa: BLE001 - no way to ask is a no
            yes = False
    if not yes:
        return 'kept', 'Not filed (no yes). Draft kept in bugs/drafts/%s.json. To file it by hand: %s' % (draft_id(d), prefilled_url(d))
    url, why = create_issue(d, env)
    if url is None:
        return 'kept', '%s. Draft kept in bugs/drafts/%s.json. File it by hand: %s' % (why, draft_id(d), prefilled_url(d))
    f = _store(d, env)
    if f is not None and f.exists():
        write_private(f, json.dumps(dict(d, issue=url), indent=1))
    return 'filed', 'Filed: %s' % url
