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
        pid = parts[1].lower()   # kith-auth ids are lowercase; a folder named Sam is still sam's
        f.update(audience='person:' + pid, room='1:1:%s:%s' % (agent, pid))
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


# ---- the load at thread start (docs/memory-context.md, "Load rule at thread start")

LOAD_CAP = 8000   # characters of the whole tier-1 block; `memory_cap:` in the agent's agent.md changes it
INDEX_NAMES = ('README.md', 'MEMORY.md', 'index.md')
WITHHELD = ('Some of what you know is kept out of this room because not everyone here may see it. When it would help '
            'the person asking, you may say "ask me in our 1:1"; never say what it is.')


def own_room(agent, reader):
    return '1:1:%s:%s' % (agent, 'owner' if reader.get('kind') == 'owner' else reader.get('id', '-'))


def is_one_to_one(room, reader):
    """`1:1:<agent>:<person>` whose person is the reader. The agent part is not compared: a helper agent a run calls
    inherits the room of the agent that called it (1:1:<parent>:<person>), and it is still the same one reader. A 1:1
    naming someone else is not the reader's."""
    who = 'owner' if reader.get('kind') == 'owner' else reader.get('id', '-')
    return room.startswith('1:1:') and room.rsplit(':', 1)[-1] == who


def is_group_room(room, agent, reader):
    """Anything but the reader's own 1:1 is read by more than one person, or is a room we cannot vouch for: fail closed."""
    return bool(room) and not is_one_to_one(room, reader)


def audience_set(reader, room=''):
    """The audience values one reader may see. reader = {'kind': owner|person|guest, 'id', 'rooms': [room ids]}.
    A guest bot is shared craft and the rooms kith-auth says it is in, never the owner's or a person's; its KITH_ROOM
    is not trusted."""
    base = {'owner': {'owner', 'shared'}, 'person': {'shared', 'person:' + reader.get('id', '-')},
            'guest': {'shared'}}.get(reader.get('kind'))
    if base is None:
        return set()
    rooms = set(reader.get('rooms', []))
    if room and reader['kind'] == 'owner' and not room.startswith('1:1:'):
        rooms.add(room)   # the owner runs in any room
    return base | {'room:' + r for r in rooms}


def load_audiences(reader, room, agent, members=None):
    """Audience values loaded for `reader` in `room`. A 1:1 loads the reader's whole set. A group room is read by
    everyone there: the intersection of the members' sets, or `shared` while the members are not known."""
    mine = audience_set(reader, room)
    if reader.get('kind') == 'guest' or not is_group_room(room, agent, reader):
        return mine
    if members is None:
        return {'shared'}
    return set.intersection(mine, *(audience_set(m, room) for m in members))


def loads(f, audiences, room, projects):
    """The filter: audience visible to everyone present, room empty or this room, projects empty or one of the current
    ones, and never project-detail (that is recall's)."""
    return (f['kind'] != 'project-detail' and f['audience'] in audiences and (not f['room'] or f['room'] == room)
            and (not f['projects'] or bool(set(f['projects']) & set(projects))))


def _read(path):
    try:
        return None if path.is_symlink() or not path.is_file() else path.read_text(errors='replace')
    except OSError:
        return None


def _notes(mem, folder, agent):
    """(rel, text, mtime, facets) for the .md files under mem/folder; links are not followed."""
    out, d = [], mem / folder
    if d.is_symlink() or not d.is_dir():
        return out
    for p in d.rglob('*.md'):
        text = _read(p)
        if text and text.strip():
            rel = p.relative_to(mem).as_posix()
            out.append((rel, text, p.stat().st_mtime, facets_for(rel, agent, text)))
    return out


def _tag(path, text, scope):
    return '<long-term-memory path="%s"%s>\n%s\n</long-term-memory>' % (
        path, ' scope="%s"' % scope if scope else '', text.rstrip('\n'))


def load_memory(agent, home, person_file, reader, room, projects, cap=LOAD_CAP, members=None):
    """The tier-1 block for a run: {'block', 'loaded', 'more', 'withheld'}. Fixed order: about you, the agent's memory
    with the person, room notes (newest first), project notes (index first, then newest). Over `cap` characters the
    oldest room and project notes go first; about you and the person's memory never do. `withheld` is set in a group
    room when the asker's own 1:1 would have loaded notes that were left out here."""
    mem = Path(home) / 'memory'
    kind = reader.get('kind')
    who = 'owner' if kind == 'owner' else reader.get('id', '-')
    if is_one_to_one(room, reader):
        room = own_room(agent, reader)   # this agent's own 1:1, whichever agent the room was named for
    group = kind != 'guest' and is_group_room(room, agent, reader)
    aud = load_audiences(reader, room, agent, members)
    solo = audience_set(reader)
    solo_room = own_room(agent, reader)
    cands = []   # (section, path, text, mtime, facets, scope, protected)
    t = _read(Path(person_file))
    if t and t.strip():
        f = state_file_facets('user' if kind == 'owner' else 'person', '' if kind == 'owner' else who, t)
        cands.append(('about', person_file, t, 0, f, 'about', True))
    own = [('MEMORY.md', '')] if kind == 'owner' else [('people/%s/MEMORY.md' % who, who)]
    shared = ('shared/MEMORY.md', 'shared')
    for rel, scope in ([*own, shared] if kind == 'owner' else [shared, *own]):
        t = _read(mem / rel) or ''
        if kind == 'owner' and scope == 'shared' and not t.strip():
            continue   # as before: the owner sees the shared part only when there is one
        cands.append(('memory', str(mem / rel), t, 0, facets_for(rel, agent, t), scope, True))
    if room and ID.match(room):
        for rel, t, mt, f in sorted(_notes(mem, 'rooms/' + room, agent), key=lambda n: -n[2]):
            cands.append(('room', str(mem / rel), t, mt, f, 'room:' + room, False))
    for p in projects:
        if ID.match(p):
            notes = sorted(_notes(mem, 'projects/' + p, agent), key=lambda n: (n[0].rsplit('/', 1)[-1] not in INDEX_NAMES, -n[2]))
            cands += [('project', str(mem / rel), t, mt, f, 'project:' + p, False) for rel, t, mt, f in notes]
    shown, withheld = [], False
    for c in cands:
        if loads(c[4], aud, room, projects):
            shown.append(c)
        elif group and c[2].strip() and loads(c[4], solo, solo_room if c[4]['room'] else room, projects):
            withheld = True
    more = 0
    for c in sorted((c for c in shown if not c[6]), key=lambda c: c[3]):   # oldest room/project notes go first
        if sum(len(x[2]) for x in shown) <= cap:
            break
        shown.remove(c)
        more += 1
    block = '\n'.join(_tag(c[1], c[2], c[5]) for c in shown)
    if withheld:
        block += '\n' + WITHHELD
    return {'block': block, 'loaded': len(shown), 'more': more, 'withheld': withheld, 'group': group}


def main(argv):
    """`kith_facets.py load ...`: prints shell assignments (mems, load_attrs) for bin/kith."""
    import argparse, os, shlex
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['load'])
    ap.add_argument('--agent', required=True)
    ap.add_argument('--home', required=True)
    ap.add_argument('--person-file', required=True)
    ap.add_argument('--kind', choices=['owner', 'person', 'guest'], required=True)
    ap.add_argument('--person', default='')
    ap.add_argument('--rooms', default='')
    ap.add_argument('--room', default='')
    ap.add_argument('--project', default='')
    ap.add_argument('--agent-md', default='')
    a = ap.parse_args(argv)
    cap = LOAD_CAP
    try:
        n = int(split_frontmatter(Path(a.agent_md).read_text())[0].get('memory_cap', '')) if a.agent_md else 0
        cap = n if n > 0 else cap
    except (OSError, ValueError):
        pass
    room = a.room if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', a.room) else ('?' if a.room else '')
    reader = {'kind': a.kind, 'id': a.person, 'rooms': [r for r in a.rooms.split() if ID.match(r)]}
    if not room and a.kind != 'guest':
        # A channel group chat sets no room: like `kith recall`, a group VIA without one is a group (shared only)
        room = '?' if os.environ.get('KITH_VIA') in ('telegram', 'slack', 'discord', 'group') else own_room(a.agent, reader)
    out = load_memory(a.agent, a.home, a.person_file, reader, room, [a.project] if a.project else [], cap)
    attrs = ' loaded="%d"%s%s' % (out['loaded'], ' more="%d"' % out['more'] if out['more'] else '',
                                  ' room="group"' if out['group'] else '')
    print('mems=%s\nload_attrs=%s' % (shlex.quote(out['block']), shlex.quote(attrs)))
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(main(sys.argv[1:]))
