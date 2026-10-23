"""kith_facets — the facets of a memory note: who may see it and where it belongs (docs/memory-context.md).

Facets come from the file's YAML frontmatter, else from the folder the file lives in. Nothing is moved or rewritten.
A file with no facets, or facets this reads wrongly, is owner-only and project-less: the most private reading, so old
data never widens. Python twin of the mapping table in the design doc; the host reads memory_entries.room itself later.
"""
import re
from pathlib import Path

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
KINDS = ('fact', 'preference', 'lesson', 'decision', 'project-detail')
OWNER_ONLY = {'audience': 'owner', 'room': '', 'projects': [], 'kind': 'fact', 'thread': '', 'about': ''}


def split_frontmatter(text):
    """(dict of the frontmatter's `key: value` lines, the text after it). Lists are `[a, b]`; no YAML library needed."""
    lines = text.split('\n')
    if lines[0].strip() != '---':
        return {}, text
    for end in range(1, min(len(lines), 60)):
        if lines[end].strip() == '---':
            fm = {}
            for line in lines[1:end]:
                k, sep, v = line.partition(':')
                if sep and re.fullmatch(r'[A-Za-z_]+', k.strip()):
                    fm[k.strip().lower()] = v.strip().strip('"\'')
            return fm, '\n'.join(lines[end + 1:])
    return {}, text


def valid_audience(a):
    kind, _, rest = a.partition(':')
    return a in ('owner', 'shared') or (kind in ('person', 'room') and bool(ID.match(rest)))


def _projects(v):
    items = [p.strip().strip('"\'') for p in v.strip('[]').split(',')]
    return [p for p in items if p and ID.match(p)]


def folder_defaults(rel, agent):
    """Default facets for `rel`, the path under an agent's memory/ (a/b/c.md)."""
    f = dict(OWNER_ONLY)
    parts = rel.split('/')
    head = parts[0]
    if head == 'shared':
        f['audience'] = 'shared'
    elif head == 'people' and len(parts) > 2 and ID.match(parts[1]):
        f.update(audience='person:' + parts[1], room='1:1:%s:%s' % (agent, parts[1]))
        if parts[2] == 'sessions':
            f.update(kind='project-detail', thread=Path(parts[-1]).stem)
    elif head == 'rooms' and len(parts) > 2 and ID.match(parts[1]):
        f.update(audience='room:' + parts[1], room=parts[1])
    elif head == 'projects' and len(parts) > 2 and ID.match(parts[1]):
        f['projects'] = [parts[1]]
    elif head == 'sessions' and len(parts) == 2:
        f.update(kind='project-detail', thread=Path(parts[1]).stem)
    return f


def apply_frontmatter(defaults, fm):
    """Frontmatter over the folder default. The audience may only stay or narrow to owner: a note's audience never
    widens by what its own text says, because agents write these files (the design's Promotion rule). Bad values are
    ignored."""
    f = dict(defaults)
    a = fm.get('audience', '')
    if a and valid_audience(a) and (a == defaults['audience'] or a == 'owner'):
        f['audience'] = a
    if fm.get('room') and ID.match(fm['room'].replace(':', '-')):
        f['room'] = fm['room']
    if 'projects' in fm:
        f['projects'] = _projects(fm['projects'])
    if fm.get('kind') in KINDS:
        f['kind'] = fm['kind']
    if fm.get('thread') and ID.match(fm['thread']):
        f['thread'] = fm['thread']
    return f


def facets_for(rel, agent, text=''):
    """Facets of the note at `rel` (under the agent's memory/) of `agent`, whose file text is `text`."""
    return apply_frontmatter(folder_defaults(rel, agent), split_frontmatter(text)[0])


def state_file_facets(kind, ident, text=''):
    """user.md (kind 'user') and people/<id>.md (kind 'person'): not an agent's."""
    f = dict(OWNER_ONLY)
    if kind == 'user':
        f['about'] = 'owner'
    elif ident and ID.match(ident):
        f.update(audience='person:' + ident, about='person:' + ident)
    return apply_frontmatter(f, split_frontmatter(text)[0])
