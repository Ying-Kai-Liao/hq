#!/usr/bin/env python3
"""Where hq's things are: the one place every tool asks.

  hq_paths.py          the folders, one per line
  hq_paths.py --sh     export lines for bash: eval "$(python3 lib/hq_paths.py --sh)"
  hq_paths.py --json   the same as JSON (the Claude Code adapter)

Two places, like ~/.claude for Claude Code:

  ~/hq    HQ_HOME, the hq folder (a link to it, so it can live anywhere, an external disk included): kernel/ (this
          repo) and agents/ (one folder per agent: role/ is its repo, memory/ data/ files/ its life)
  ~/.hq   this Mac's hq, a real folder on the internal disk: what hq has lived (user.md, projects/, projects.json,
          agents.json, private-words: the hq-state repo, ~/.hq itself) and what only this machine needs, never
          committed: secrets/ (auth.json, env), settings.json (hq_settings.py), job state, the cost ledger,
          store/ (role snapshots), logs/, cache/

HQ_HOME set: that folder instead of ~/hq. Before ~/.hq became a real folder it was a link to the hq folder; then the
state is <home>/state, machine things are in ~/.config/hq, logs in ~/Library/Logs/hq, caches in ~/Library/Caches/hq
and snapshots in <agents>/.store.

Paths come in two spellings, each for one job: the address (no symlinks resolved, so no spaces from a volume name
end up in prompts and Bash permission rules) and the real path (symlinks resolved), which is what Claude Code
compares file permission rules against ({{HOME_REAL}}).
"""
import json, os, shlex, sys
from pathlib import Path

KERNEL = Path(__file__).resolve().parent.parent
DOT = Path.home() / '.hq'


def paths():
    mine = DOT.is_dir() and not DOT.is_symlink()   # ~/.hq is this Mac's folder, not a link to the hq folder
    given = os.environ.get('HQ_HOME', '').strip()
    linked = Path.home() / 'hq'
    # Without either link: the hq folder around the kernel when it sits there as kernel/, else the kernel folder.
    fallback = KERNEL.parent if KERNEL.name == 'kernel' else KERNEL
    home = (Path(os.path.expanduser(given)) if given else linked if linked.is_dir()
            else DOT if DOT.is_symlink() and DOT.is_dir() else fallback)
    out = {'HQ_HOME': home, 'HQ_STATE': DOT if mine else home / 'state', 'HQ_AGENTS': home / 'agents'}
    out.update({k + '_REAL': Path(os.path.realpath(v)) for k, v in list(out.items())})
    if mine:
        out.update(HQ_MACHINE=DOT, HQ_SECRETS=DOT / 'secrets', HQ_LOGS=DOT / 'logs', HQ_CACHE=DOT / 'cache',
                   HQ_STORE=DOT / 'store')
    else:
        config = Path.home() / '.config/hq'
        out.update(HQ_MACHINE=config, HQ_SECRETS=config, HQ_LOGS=Path.home() / 'Library/Logs/hq',
                   HQ_CACHE=Path.home() / 'Library/Caches/hq', HQ_STORE=home / 'agents' / '.store')
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
