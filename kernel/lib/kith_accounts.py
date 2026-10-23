#!/usr/bin/env python3
"""Backup chain entries: what an id means, whether it is ready, and how it launches.

An entry id is `<harness>` or `<harness>:<name>`:

  claude              the ambient Claude login (what runs today)
  claude:<name>       an extra Claude subscription account: CLAUDE_CONFIG_DIR=<machine>/accounts/claude/<name>
  claude-api:<profile>  an Anthropic API key held by kith-auth (anthropic/<profile>), handed to Claude Code through
                      apiKeyHelper, so the key is never in env, JSON or logs
  codex               the ambient Codex login (~/.codex)
  codex:<name>        CODEX_HOME=<machine>/accounts/codex/<name>
  anything else       a harness the host may learn later; here it is "not runnable yet"

Readiness is asked of the harness's own status command with the right config dir; no token, credential file or
Keychain item is ever read. The settings are lib/kith_settings.py's `backups`.

  kith_accounts.py backups-json AGENT AGENT.MD   the chain for `kith AGENT --backups-json`
  kith_accounts.py launch-env AGENT ID           shell assignments for bin/kith; exit 4 + one line on stderr when not runnable
"""
import json, os, re, shlex, subprocess, sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kith_settings  # noqa: E402
from kith_paths import paths  # noqa: E402

KERNEL = Path(__file__).resolve().parent.parent
ID_RE = re.compile(r'^([a-z][a-z0-9-]*)(?::([A-Za-z0-9][A-Za-z0-9._-]*))?$')
STATUS_TIMEOUT = 20


def parse(entry):
    """(harness, name or None); ValueError says what is wrong with the id."""
    m = ID_RE.match(entry or '')
    if not m:
        raise ValueError(f"'{entry}' is not a backup id: use <harness> or <harness>:<name> (claude, claude:work, claude-api:main, codex)")
    harness, name = m.groups()
    if harness == 'claude-api' and not name:
        raise ValueError("claude-api needs a profile: claude-api:<profile>")
    return harness, name


def machine():
    return paths()['KITH_MACHINE']


def account_dir(harness, name):
    return machine() / 'accounts' / harness / name


def kind(harness, name):
    return 'api-key' if harness == 'claude-api' else 'subscription'


def run_harness(argv, env_extra):
    """Run a status command; (exit code or None when not installed, stdout)."""
    try:
        r = subprocess.run(argv, env={**os.environ, **env_extra}, capture_output=True, text=True,
                           timeout=STATUS_TIMEOUT, stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        return None, ''
    except subprocess.TimeoutExpired:
        return 124, ''
    return r.returncode, r.stdout


def logged_in(harness, directory=None):
    """(True/False, why). claude auth status / codex login status, in the account's dir when it has one."""
    env = {}
    if harness == 'claude':
        argv = ['claude', 'auth', 'status']
        if directory:
            env['CLAUDE_CONFIG_DIR'] = str(directory)
    else:
        argv = ['codex', 'login', 'status']
        if directory:
            env['CODEX_HOME'] = str(directory)
    code, out = run_harness(argv, env)
    if code is None:
        return False, f'{harness} is not installed'
    if code == 124:
        return False, f'{harness} did not answer'
    if code != 0:
        return False, 'not logged in'
    try:
        d = json.loads(out)
        if isinstance(d, dict) and d.get('loggedIn') is False:
            return False, 'not logged in'
    except ValueError:
        pass
    return True, None


def granted_profiles(agent, service):
    """The profiles kith-auth grants the agent for a service (names only; no secret is read)."""
    if not agent:
        return []
    r = subprocess.run([str(KERNEL / 'bin/kith-auth'), 'granted', '--for', agent, service], capture_output=True,
                       text=True, stdin=subprocess.DEVNULL, timeout=STATUS_TIMEOUT)
    return r.stdout.split() if r.returncode == 0 else []


def fix(entry, agent=None):
    """The one command that makes an entry ready."""
    harness, name = parse(entry)
    if harness in ('claude', 'codex') and name:
        return f'kith account add {harness} {name}'
    if harness == 'claude':
        return 'claude auth login'
    if harness == 'codex':
        return 'codex login'
    if harness == 'claude-api':
        return (f'kith auth set anthropic/{name} ANTHROPIC_API_KEY && '
                f'kith auth grant {agent or "<agent>"} anthropic anthropic/{name}')
    return None


def check(entry, agent=None):
    """(ready, why). Unknown harnesses are never ready here."""
    harness, name = parse(entry)
    if harness == 'claude-api':
        if subprocess.run(['which', 'claude'], capture_output=True).returncode != 0:
            return False, 'claude is not installed'
        if f'anthropic/{name}' in granted_profiles(agent, 'anthropic'):
            return True, None
        return False, f'no anthropic/{name} key granted to {agent or "the agent"}'
    if harness in ('claude', 'codex'):
        if not name:
            return logged_in(harness)
        d = account_dir(harness, name)
        if not d.is_dir():
            return False, f'no account {name}'
        return logged_in(harness, d)
    return False, f'{harness} is not supported yet'


def agent_harness(agent_md):
    try:
        m = re.match(r'---\n(.*?)\n---', Path(agent_md).read_text(), re.S)
        f = re.search(r'^harness:[ \t]*(\S+)', m.group(1), re.M) if m else None
    except OSError:
        f = None
    h = f.group(1) if f else 'claude'
    return 'claude' if h == 'claude-code' else h


def entry_json(entry, agent, primary=False):
    harness, name = parse(entry)
    if primary:
        return {'id': entry, 'harness': harness, 'account': name, 'kind': 'primary', 'ready': True}
    ready, why = check(entry, agent)
    out = {'id': entry, 'harness': 'claude' if harness == 'claude-api' else harness, 'account': name,
           'kind': kind(harness, name), 'ready': ready}
    if not ready:
        out['why'] = why
    return out


def chain(agent, agent_md):
    ids, _ = kith_settings.backups(agent)
    items = [entry_json(agent_harness(agent_md), agent, primary=True)]
    for i in ids:
        try:
            items.append(entry_json(i, agent))
        except ValueError as e:   # a hand-edited bad id: listed as not ready rather than failing the whole chain
            items.append({'id': i, 'harness': None, 'account': None, 'kind': 'unknown', 'ready': False, 'why': str(e)})
    return {'version': 1, 'agent': agent, 'chain': items}


def api_helper(agent, name):
    """The apiKeyHelper command: prints the key on demand, run by Claude Code, so the key never passes through us."""
    return ' '.join(shlex.quote(a) for a in [str(KERNEL / 'bin/kith-auth'), 'get', '--for', agent, '--profile',
                                              f'anthropic/{name}', 'anthropic', 'ANTHROPIC_API_KEY'])


def launch_env(agent, entry):
    """Shell assignments for bin/kith. Raises ValueError (exit 4) when the entry can't run."""
    harness, name = parse(entry)
    if harness not in ('claude', 'claude-api', 'codex'):
        raise ValueError(f'{entry}: {harness} is not supported in launch-json yet')
    ready, why = check(entry, agent)
    if not ready:
        hint = fix(entry, agent)
        raise ValueError(f'{entry}: {why}' + (f' (make it ready: {hint})' if hint else ''))
    q = shlex.quote
    run_harness_name = 'claude' if harness == 'claude-api' else harness
    cfg_var = cfg_dir = ''
    if name and harness in ('claude', 'codex'):
        cfg_var = 'CLAUDE_CONFIG_DIR' if harness == 'claude' else 'CODEX_HOME'
        cfg_dir = str(account_dir(harness, name))
    helper = api_helper(agent, name) if harness == 'claude-api' else ''
    return (f'backup_harness={q(run_harness_name)} backup_account={q(name or "")} backup_cfg_var={q(cfg_var)} '
            f'backup_cfg_dir={q(cfg_dir)} backup_api_helper={q(helper)}')


if __name__ == '__main__':
    a = sys.argv[1:]
    try:
        if len(a) == 3 and a[0] == 'backups-json':
            print(json.dumps(chain(a[1], a[2])))
        elif len(a) == 3 and a[0] == 'launch-env':
            print(launch_env(a[1], a[2]))
        else:
            sys.exit(__doc__.strip())
    except ValueError as e:
        print(f'kith: {e}', file=sys.stderr)
        sys.exit(4)
