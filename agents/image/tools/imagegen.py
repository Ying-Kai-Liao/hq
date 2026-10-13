#!/usr/bin/env python3
"""imagegen — generate or edit raster images through Codex's built-in image_gen (ChatGPT login, no API key).

  imagegen.py "<prompt>" --out PATH [--n N] [--ref IMG]... [--edit IMG] [--transparent] [--timeout SEC]

  --out PATH       where the image goes (.png). Never overwrites: an existing name becomes name-v2.png, -v3…
  --n N            N variants of the same prompt (name-1.png … name-N.png); max 4
  --ref IMG        reference image for style/composition/subject (repeatable)
  --edit IMG       the image to edit; the prompt says what to change and what to keep
  --transparent    ask for a real transparent background (alpha kept)

Prints one JSON line: {"ok": true, "files": [...], "seconds": n} or {"ok": false, "error": "..."}.
Codex runs with no user config, read-only sandbox, ephemeral session; images are found by its thread id under
$CODEX_HOME/generated_images/<thread>/ and copied here, so the result never depends on the model copying files.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

CODEX_HOME = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex'))


def free_path(p):
    """p if unused, else p-v2, p-v3…"""
    if not p.exists():
        return p
    i = 2
    while (q := p.with_name(f'{p.stem}-v{i}{p.suffix}')).exists():
        i += 1
    return q


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('prompt')
    ap.add_argument('--out', required=True)
    ap.add_argument('--n', type=int, default=1)
    ap.add_argument('--ref', action='append', default=[])
    ap.add_argument('--edit')
    ap.add_argument('--transparent', action='store_true')
    ap.add_argument('--timeout', type=int, default=600)
    a = ap.parse_args()

    def fail(msg):
        print(json.dumps({'ok': False, 'error': msg}))
        sys.exit(1)

    if not 1 <= a.n <= 4:
        fail('--n must be 1–4')
    if not shutil.which('codex'):
        fail('codex CLI not found (brew install codex, then `codex login`)')
    images = ([a.edit] if a.edit else []) + a.ref
    for img in images:
        if not Path(img).is_file():
            fail(f'no such image: {img}')

    roles = []
    if a.edit:
        roles.append('Image 1 is the EDIT TARGET: change only what the request asks, keep everything else unchanged.')
    for i, _ in enumerate(a.ref, start=2 if a.edit else 1):
        roles.append(f'Image {i} is a REFERENCE (style/composition/subject guidance), not something to edit.')
    task = (
        f'Call your built-in image_gen tool exactly {a.n} time(s), once per variant, with the request below. '
        'Do not run shell commands, read files or skills, or save anything yourself. '
        + ('Ask image_gen for a genuinely transparent background and keep the alpha. ' if a.transparent else '')
        + ' '.join(roles)
        + ' When done, reply with one line: DONE, or FAILED: <reason>.\n\nRequest:\n' + a.prompt
    )
    cmd = ['codex', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
           '--enable', 'image_generation', '-s', 'read-only', '--json']
    for img in images:
        cmd += ['-i', str(Path(img).resolve())]

    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            r = subprocess.run(cmd + ['-C', tmp, '--', task], capture_output=True, text=True, timeout=a.timeout,
                               stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            fail(f'codex timed out after {a.timeout}s')
    thread, last = None, ''
    for line in r.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('type') == 'thread.started':
            thread = e.get('thread_id')
        elif e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message':
            last = e['item'].get('text', '')
        elif e.get('type') in ('error', 'turn.failed'):
            last = json.dumps(e)[:400]
    if not thread:
        fail(f'codex exited {r.returncode} without a thread: {(r.stderr or r.stdout)[-400:]}')
    made = sorted((CODEX_HOME / 'generated_images' / thread).glob('*'), key=lambda p: p.stat().st_mtime)
    if not made:
        fail(f'no image produced. codex said: {last[:400]}')

    out = Path(a.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    files = []
    for i, src in enumerate(made, 1):
        name = out if len(made) == 1 else out.with_name(f'{out.stem}-{i}{out.suffix}')
        dst = free_path(name.with_suffix(src.suffix or out.suffix))
        shutil.copy2(src, dst)
        files.append(str(dst))
    res = {'ok': True, 'files': files, 'seconds': round(time.time() - t0)}
    if len(made) != a.n:
        res['note'] = f'asked for {a.n}, got {len(made)}'
    print(json.dumps(res))


if __name__ == '__main__':
    main()
