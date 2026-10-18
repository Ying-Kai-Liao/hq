#!/usr/bin/env python3
"""hq's own settings: hq-wide, not secret, for this Mac.

  hq_settings.py KEY            print one setting: this Mac's ~/.hq/settings.json, else hq's default
  hq_settings.py KEY AGENT      print this Mac's choice for one agent (agents.AGENT.KEY), empty when there is none

Settings that are hq's, not one agent's (its settings.json), one account's (hq-auth) or one entry point's (an env
var such as HQ_BRIDGE_PERMISSION_MODE). The file is this Mac's and is never committed, like secrets/env: what an
unattended Mac may do is decided per Mac. Without the file, or for a key it leaves out, the default below.

  permission_mode   the mode an owner's Claude Code run starts in when neither the caller (HQ_PERMISSION_MODE and
                    the entry points' variables) nor the agent's settings.json (permissions.defaultMode) chose one
  agents            per agent, what this Mac chose over the agent's own settings: {"<agent>": {"permission_mode":
                    MODE}}. An agent's defaultMode is its author's suggestion; the mode chosen here (hq install asks)
                    wins over it, and only the caller's wins over this; {"live_at_login": true} for a live agent
                    (session: live) whose session starts when you log in to this Mac (hq live login)
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hq_paths import paths  # noqa: E402  the one place that knows where hq's folders are

FILE = paths()['HQ_MACHINE'] / 'settings.json'
DEFAULTS = {'permission_mode': 'auto'}
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
    for where, d in [('', s)] + [(f'agents.{n}.', a) for n, a in agents.items()]:
        for k, v in d.items():
            if k in CHOICES and v not in CHOICES[k]:
                return {}, f'{FILE}: {where}{k} {v!r} is not one of {", ".join(CHOICES[k])}'
    return s, None


def get(key, agent=None):
    """hq's setting, or with an agent this Mac's choice for it ('' when there is none)."""
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
    FILE.parent.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(s, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3) or sys.argv[1] not in DEFAULTS:
        sys.exit(__doc__.strip())
    print(get(*sys.argv[1:]))
