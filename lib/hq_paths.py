#!/usr/bin/env python3
"""Where hq's things are: the one place every tool asks.

  hq_paths.py          the folders, one per line
  hq_paths.py --sh     export lines for bash: eval "$(python3 lib/hq_paths.py --sh)"
  hq_paths.py --json   the same as JSON (the Claude Code adapter)

One setting, HQ_HOME: the folder that holds agents/ (one folder per agent: role/ is its repo, memory/ data/ files/
its life) and state/ (hq's own records: user.md, projects, agents.json; your private hq-state repo). Unset, it is
~/.hq, the stable address (usually a link to the hq folder, so the folder can live anywhere, an external disk
included), else the kernel folder itself.

Paths come in two spellings, each for one job: the address (HQ_HOME as given, no symlinks resolved, so no spaces
from a volume name end up in prompts and Bash permission rules) and the real path (symlinks resolved), which is
what Claude Code compares file permission rules against ({{HOME_REAL}}).

Machine-only things never live under HQ_HOME: ~/.config/hq (secrets, grants, settings, the cost ledger),
~/Library/Logs/hq (logs), ~/Library/Caches/hq (anything rebuildable).
"""
import json, os, shlex, sys
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
MACHINE = Path.home() / '.config/hq'
LOGS = Path.home() / 'Library/Logs/hq'
CACHE = Path.home() / 'Library/Caches/hq'


def paths():
    given = os.environ.get('HQ_HOME', '').strip()
    dot = Path.home() / '.hq'
    home = Path(os.path.expanduser(given)) if given else dot if dot.is_dir() else KERNEL
    out = {'HQ_HOME': home, 'HQ_STATE': home / 'state', 'HQ_AGENTS': home / 'agents'}
    out.update({k + '_REAL': Path(os.path.realpath(v)) for k, v in list(out.items())})
    out.update(HQ_MACHINE=MACHINE, HQ_LOGS=LOGS, HQ_CACHE=CACHE)
    return out


if __name__ == '__main__':
    p = {k: str(v) for k, v in paths().items()}
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg == '--sh':
        print('\n'.join('export %s=%s' % (k, shlex.quote(v)) for k, v in p.items()))
    elif arg == '--json':
        print(json.dumps(p))
    else:
        print('\n'.join('%-15s %s' % kv for kv in p.items()))
