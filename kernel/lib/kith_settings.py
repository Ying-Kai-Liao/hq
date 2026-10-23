#!/usr/bin/env python3
"""kith's own settings: kith-wide, not secret, for this Mac.

  kith_settings.py KEY            print one setting: this Mac's ~/.kith/settings.json, else kith's default
  kith_settings.py KEY AGENT      print this Mac's choice for one agent (agents.AGENT.KEY), empty when there is none

Settings that are kith's, not one agent's (its settings.json), one account's (kith-auth) or one entry point's (an env
var such as KITH_BRIDGE_PERMISSION_MODE). The file is this Mac's and is never committed, like secrets/env: what an
unattended Mac may do is decided per Mac. Without the file, or for a key it leaves out, the default below.

  permission_mode   the mode an owner's Claude Code run starts in when neither the caller (KITH_PERMISSION_MODE and
                    the entry points' variables) nor the agent's settings.json (permissions.defaultMode) chose one
  plugins           Claude Code plugins (ids, as `claude plugin list` shows them) every agent's run turns on, e.g.
                    ["jev-effort-router@jev-effort-router"]; an agent whose settings.json sets one in enabledPlugins
                    keeps its own choice. Without it, runs turn on kith@kith only
  agents            per agent, what this Mac chose over the agent's own settings: {"<agent>": {"permission_mode":
                    MODE}}. An agent's defaultMode is its author's suggestion; the mode chosen here (kith install asks)
                    wins over it, and only the caller's wins over this; {"live_at_login": true} for a live agent
                    (session: live) whose session starts when you log in to this Mac (kith live login)
  backups           the backup chain kith serve tries when the agent's own harness runs out of usage: entry ids in
                    order ("claude:work", "claude-api:main", "codex"; see lib/kith_accounts.py). Empty by default.
                    agents.<agent>.backups replaces it for that agent; an explicit [] means no backups for it
                    (kith backup list|add|remove edits both)

  kith_settings.py backups [AGENT]   the chain that applies, one id per line
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from kith_paths import paths  # noqa: E402  the one place that knows where kith's folders are

FILE = paths()['KITH_MACHINE'] / 'settings.json'
DEFAULTS = {'permission_mode': 'auto', 'plugins': [], 'backups': []}
CHOICES = {'permission_mode': ('default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions')}


def read():
    """(what the file sets, why it can't be used or None). A file that can't be used sets nothing."""
    try:
        s = json.loads(FILE.read_text())
    except FileNotFoundError:
        return {}, None
    except (OSError, ValueError) as e:
        return {}, f'{FILE} is unreadable ({e})'
    if not isinstance(s, dict):
        return {}, f'{FILE} is not a JSON object'
    agents = s.get('agents', {})
    if not isinstance(agents, dict) or not all(isinstance(a, dict) for a in agents.values()):
        return {}, f'{FILE}: agents is not {{"<agent>": {{...}}}}'
    plugins = s.get('plugins', [])
    if not isinstance(plugins, list) or not all(isinstance(p, str) for p in plugins):
        return {}, f'{FILE}: plugins is not a list of plugin ids'
    for where, d in [('', s)] + [(f'agents.{n}.', a) for n, a in agents.items()]:
        b = d.get('backups', [])
        if not isinstance(b, list) or not all(isinstance(i, str) for i in b):
            return {}, f'{FILE}: {where}backups is not a list of entry ids'
        for k, v in d.items():
            if k in CHOICES and v not in CHOICES[k]:
                return {}, f'{FILE}: {where}{k} {v!r} is not one of {", ".join(CHOICES[k])}'
    return s, None


def get(key, agent=None):
    """kith's setting, or with an agent this Mac's choice for it ('' when there is none)."""
    if agent:
        return read()[0].get('agents', {}).get(agent, {}).get(key, '')
    return read()[0].get(key, DEFAULTS[key])


def choose(agent, key, value):
    """Record this Mac's choice for one agent, keeping the rest of the file."""
    s, why = read()
    if why:
        raise ValueError(why)
    if key in CHOICES and value not in CHOICES[key]:
        raise ValueError(f'{key} {value!r} is not one of {", ".join(CHOICES[key])}')
    s.setdefault('agents', {}).setdefault(agent, {})[key] = value
    write(s)


def write(s):
    """The whole file, atomically (a reader never sees half of it)."""
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_name(FILE.name + '.tmp')
    tmp.write_text(json.dumps(s, indent=2) + '\n')
    os.replace(tmp, FILE)


def backups(agent=None):
    """(ids, where): the chain that applies to the agent, and whether it is the agent's own ('agent', even when []) or 'global'."""
    s = read()[0]
    own = s.get('agents', {}).get(agent, {}) if agent else {}
    if 'backups' in own:
        return list(own['backups']), 'agent'
    return list(s.get('backups', [])), 'global'


def set_backups(agent, ids):
    """Record the chain: one agent's override, or with agent None the global one. Keeps the rest of the file."""
    s, why = read()
    if why:
        raise ValueError(why)
    if agent:
        s.setdefault('agents', {}).setdefault(agent, {})['backups'] = list(ids)
    else:
        s['backups'] = list(ids)
    write(s)


def clear_backups(agent):
    """Drop one agent's own chain, so it follows the global one again. Keeps the rest of the file."""
    s, why = read()
    if why:
        raise ValueError(why)
    own = s.get('agents', {}).get(agent)
    if own is not None and 'backups' in own:
        del own['backups']
        write(s)


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3) or sys.argv[1] not in DEFAULTS:
        sys.exit(__doc__.strip())
    if sys.argv[1] == 'backups':
        print('\n'.join(backups(*sys.argv[2:])[0]))
        sys.exit(0)
    v = get(*sys.argv[1:])
    print('\n'.join(v) if isinstance(v, list) else v)
