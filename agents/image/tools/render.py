"""Shared helpers for chart.py and infographic.py: theme, sizes, and HTML → PNG through headless Chrome."""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
CHROME = os.environ.get('HQ_CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
EXTRA = 400  # headless Chrome's viewport is ~90 px shorter than its window: render taller, page centred, crop
PRESETS = json.loads((TOOLS / 'presets.json').read_text())


def die(msg):
    print(json.dumps({'ok': False, 'error': msg}))
    sys.exit(1)


def theme(path=None):
    """The house theme, with a project theme file (any subset of keys) laid over it."""
    t = json.loads((TOOLS / 'themes' / 'hq.json').read_text())
    if path:
        p = Path(path).expanduser()
        if not p.is_file():
            p = TOOLS / 'themes' / f'{path}.json'
        if not p.is_file():
            die(f'no theme {path}')
        t.update(json.loads(p.read_text()))
    return t


def size(preset=None, wxh=None, default='ig-portrait'):
    if wxh:
        try:
            w, h = (int(x) for x in wxh.lower().split('x'))
            return w, h
        except ValueError:
            die('--size must look like 1200x630')
    name = preset or default
    if name not in PRESETS:
        die(f'unknown preset {name}; known: {", ".join(PRESETS)}')
    return PRESETS[name]['w'], PRESETS[name]['h']


def free_path(p):
    p = Path(p).expanduser()
    if not p.exists():
        return p
    i = 2
    while (q := p.with_name(f'{p.stem}-v{i}{p.suffix}')).exists():
        i += 1
    return q


def grain_css(t):
    if not t.get('grain'):
        return ''
    svg = ("<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'>"
           "<feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/>"
           "<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'/></filter>"
           "<rect width='100%' height='100%' filter='url(#n)'/></svg>")
    from urllib.parse import quote
    return (f"body::after{{content:'';position:fixed;inset:0;pointer-events:none;opacity:{t['grain']};"
            f"background-image:url(\"data:image/svg+xml,{quote(svg)}\");mix-blend-mode:multiply}}")


def html_to_png(html, w, h, out, keep_html=True):
    """Render at 2x for crisp text, then downscale to exactly w×h. Saves OUT.html next to it for edits."""
    if not Path(CHROME).exists():
        die(f'Chrome not found at {CHROME} (set HQ_CHROME)')
    out = free_path(out if str(out).endswith('.png') else f'{out}.png')
    out.parent.mkdir(parents=True, exist_ok=True)
    src = out.with_suffix('.html')
    src.write_text(html)
    # Push the page down by half the extra height so it sits in the middle of the screenshot; sips crops centred.
    shift = f'<style>html{{padding-top:{EXTRA // 2}px!important;box-sizing:content-box!important}}</style>'
    shot_html = Path(src.parent / f'.{src.stem}.render.html')
    shot_html.write_text(html.replace('<head>', '<head>' + shift, 1) if '<head>' in html else shift + html)
    with tempfile.TemporaryDirectory() as tmp:
        shot = Path(tmp) / 'shot.png'
        # A private profile keeps parallel renders apart, but headless Chrome then lingers after writing the
        # screenshot, so wait for the file and stop it ourselves.
        proc = subprocess.Popen([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
                                 f'--user-data-dir={tmp}/profile', '--force-device-scale-factor=2',
                                 '--allow-file-access-from-files', '--virtual-time-budget=3000',
                                 f'--window-size={w},{h + EXTRA}', f'--screenshot={shot}', shot_html.resolve().as_uri()],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline, last = time.time() + 60, -1
        while time.time() < deadline and proc.poll() is None:
            if shot.exists() and shot.stat().st_size == last > 0:
                break
            last = shot.stat().st_size if shot.exists() else -1
            time.sleep(0.3)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if not shot.exists():
            die(f'Chrome did not render: {(proc.stderr.read() if proc.stderr else "")[-300:]}')
        # Keep the centred w×h (at 2x), then scale to exactly w×h.
        subprocess.run(['sips', '-c', str(2 * h), str(2 * w), str(shot)], capture_output=True, check=True)
        subprocess.run(['sips', '-z', str(h), str(w), str(shot), '--out', str(out)], capture_output=True, check=True)
    shot_html.unlink()
    if not keep_html:
        src.unlink()
    return out
