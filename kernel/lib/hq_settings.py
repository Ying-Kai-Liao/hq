#!/usr/bin/env python3
"""hq's own settings: hq-wide, not secret, for this Mac.

  hq_settings.py KEY   print one setting: this Mac's ~/.hq/settings.json, else hq's default

Settings that are hq's, not one agent's (its settings.json), one account's (hq-auth) or one entry point's (an env
var such as HQ_BRIDGE_PERMISSION_MODE). The file is this Mac's and is never committed, like secrets/env: what an
unattended Mac may do is decided per Mac. Without the file, or for a key it leaves out, the default below.

  permission_mode   the mode an owner's Claude Code run starts in when neither the caller (HQ_PERMISSION_MODE and
                    the entry points' variables) nor the agent's settings.json (permissions.defaultMode) chose one
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from hq_paths import paths  # noqa: E402  the one place that knows where hq's folders are

FILE = paths()['HQ_MACHINE'] / 'settings.json'
DEFAULTS = {'permission_mode': 'auto'}
CHOICES = {'permission_mode': ('default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions')}


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
    for k, v in s.items():
        if k in CHOICES and v not in CHOICES[k]:
            return {}, f'{FILE}: {k} {v!r} is not one of {", ".join(CHOICES[k])}'
    return s, None


def get(key):
    return read()[0].get(key, DEFAULTS[key])


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in DEFAULTS:
        sys.exit(__doc__.strip())
    print(get(sys.argv[1]))
