#!/usr/bin/env python3
"""Build HyperFrames compositions from a screen recording (footage and hybrid modes of the screen-demo skill).

A project is a project.json next to a clips/ folder of CFR proxies (see prep.sh):
  {"source": [w, h], "max_mag": 1.7, "font": "Inter",
   "colors": {"ink": "#15171C", "paper": "#EEEDE8", "accent_light": "#0B9A68", "accent_dark": "#2FD18F"},
   "brand": {"mark": "/abs/mark-reversed.svg", "lockup": "/abs/lockup-reversed.svg"},
   "regions": {"name": [x, y, w, h], ...},      # source px
   "specs": {"<comp>": {...}, ...}}               # or "specs_file": "specs.json"
Each spec: stage, segments of footage, camera keyframes (focus rects in source px), overlays. See SKILL.md.
Camera = one transform on #cam (translate + scale, origin 0 0) so the window, callouts and cursor move together.
Move duration follows the anchor-camera rule: 0.35 s + 1.35 ms per px travelled, clamped 0.6-2.4 s.
usage: build.py <project.json> [comp ...]   (writes <project>/comps/<comp>/index.html and copies clips)
"""
import json, math, shutil, sys
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit(__doc__)
PROJ = Path(sys.argv[1]).resolve()
CFG = json.loads(PROJ.read_text())
ROOT = PROJ.parent
CLIPS = ROOT / CFG.get('clips', 'clips')
OUT = ROOT / CFG.get('out', 'comps')
VW, VH = CFG['source']         # source recording size in px (retina recordings are 2 px per pt)
MAX_MAG = CFG.get('max_mag', 1.7)  # max magnification per source px; 1.7 keeps retina terminal text sharp
FONT = CFG.get('font', '{FONT}')
_c = CFG.get('colors', {})
INK, PAPER = _c.get('ink', '#15171C'), _c.get('paper', '#EEEDE8')
GREEN_D, GREEN_L = _c.get('accent_dark', '#2FD18F'), _c.get('accent_light', '#0B9A68')   # the one accent colour
BRAND = {k: Path(v).expanduser() for k, v in CFG.get('brand', {}).items()}
R = {k: tuple(v) for k, v in CFG.get('regions', {}).items()}
SPECS = CFG.get('specs') or json.loads((ROOT / CFG['specs_file']).read_text())


def ease_dur(a, b):
    d = math.hypot(a['tx'] - b['tx'], a['ty'] - b['ty']) + abs(a['z'] - b['z']) * 600
    return max(0.6, min(2.4, 0.35 + 0.00135 * d))


class Stage:
    def __init__(self, W, H, win_h_frac=0.83):
        self.W, self.H = W, H
        self.s0 = min(H * win_h_frac / VH, W * 0.86 / VW)
        self.ww, self.wh = VW * self.s0, VH * self.s0
        self.left, self.top = (W - self.ww) / 2, (H - self.wh) / 2

    def wide(self):
        return {'tx': 0, 'ty': 0, 'z': 1}

    def focus(self, rect, fill=0.9, cx_off=0.0, cy_off=0.0):
        x, y, w, h = R[rect] if isinstance(rect, str) else rect
        z = min(self.W * fill / (w * self.s0), self.H * fill / (h * self.s0), MAX_MAG / self.s0)
        z = max(z, 1)
        cx = self.left + (x + w / 2) * self.s0
        cy = self.top + (y + h / 2) * self.s0
        return {'tx': round(self.W / 2 * (1 + cx_off) - z * cx, 1), 'ty': round(self.H / 2 * (1 + cy_off) - z * cy, 1), 'z': round(z, 4)}

    def box(self, rect, pad=10):
        x, y, w, h = R[rect]
        return (self.left + x * self.s0 - pad, self.top + y * self.s0 - pad, w * self.s0 + 2 * pad, h * self.s0 + 2 * pad)


def css(W, H, theme):
    bg = PAPER if theme == 'paper' else INK
    fg = INK if theme == 'paper' else '#FFFFFF'
    green = GREEN_L if theme == 'paper' else GREEN_D
    return f"""
  [data-composition-id] {{ position:relative; width:{W}px; height:{H}px; overflow:hidden; background:{bg};
    font-family:'{FONT}', system-ui, sans-serif; color:{fg}; }}
  .grain {{ position:absolute; inset:-50%; z-index:40; pointer-events:none; opacity:{0.07 if theme == 'paper' else 0.05};
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }}
  #cam {{ position:absolute; left:0; top:0; width:{W}px; height:{H}px; transform-origin:0 0; z-index:10; }}
  .win {{ position:absolute; overflow:hidden; border-radius:14px; background:#1e1f22;
    box-shadow:0 30px 80px rgba(21,23,28,{0.28 if theme == 'paper' else 0.6}), 0 0 0 1px rgba({'21,23,28,.10' if theme == 'paper' else '255,255,255,.08'}); }}
  .vwrap {{ position:absolute; inset:0; }}
  .vwrap video {{ width:100%; height:100%; display:block; }}
  .callout {{ position:absolute; border:4px solid {green}; border-radius:12px; z-index:12; }}
  .chip {{ position:absolute; z-index:13; background:{green}; color:{INK}; font:600 22px '{FONT}'; padding:8px 14px;
    border-radius:999px; letter-spacing:.01em; }}
  .cap {{ position:absolute; left:0; right:0; bottom:{int(H * 0.07)}px; display:flex; justify-content:center; z-index:30; }}
  .cap span {{ background:{fg}; color:{bg}; font:600 {int(H * 0.04)}px/1.15 '{FONT}'; padding:{int(H*0.012)}px {int(H*0.022)}px; border-radius:14px;
    max-width:{int(W * 0.8)}px; text-align:center; }}
  .cap .g {{ color:{green if theme == 'ink' else GREEN_D}; }}
  .head {{ position:absolute; z-index:30; left:{int(W*0.06)}px; top:{int(H*0.08)}px; font:700 {int(min(W,H)*0.075)}px/1.02 '{FONT}';
    letter-spacing:-.03em; color:#fff; max-width:{int(W*0.6)}px; background:{INK}; padding:{int(H*0.018)}px {int(H*0.03)}px {int(H*0.024)}px;
    border-radius:18px; box-shadow:0 20px 60px rgba(0,0,0,.45); }}
  .head .g {{ color:{GREEN_D}; }}
  .card-scene {{ position:absolute; inset:0; z-index:50; background:{INK}; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:{int(H*0.04)}px; }}
  .card-scene .tag {{ font:500 {int(min(W,H)*0.04)}px '{FONT}'; color:#C9CCD2; letter-spacing:.01em; }}
"""


def video_tag(i, seg, start, dur, track, media_start=0):
    return (f'<video id="v{i}" data-start="{start}" data-duration="{dur}" data-track-index="{track}" '
            f'data-media-start="{media_start}" src="{seg}.mp4" muted playsinline></video>')


def build(name, spec):
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)
    W, H = spec.get('size', (1920, 1080))
    st = Stage(W, H, spec.get('win_h', 0.83))
    theme = spec.get('theme', 'paper')
    total = spec['duration']
    tl, body = [], []

    # footage: each segment gets its own non-timed wrapper (crossfades animate the wrapper)
    vids = []
    for i, s in enumerate(spec['segments']):
        shutil.copy(CLIPS / f"{s['clip']}.mp4", out / f"{s['clip']}.mp4")
        vids.append(f'<div class="vwrap" id="w{i}" style="opacity:{1 if i == 0 else 0}">'
                    + video_tag(i, s['clip'], s['start'], s['dur'], i % 2, s.get('media_start', 0)) + '</div>')
        if i > 0:
            tl.append(f'tl.to("#w{i}", {{opacity:1, duration:{s.get("xfade", 0.3)}, ease:"power1.inOut"}}, {s["start"]});')
            tl.append(f'tl.set("#w{i-1}", {{opacity:0}}, {s["start"] + s.get("xfade", 0.3)});')

    if spec.get('raw'):
        body.append(f'<div id="cam"><div class="win" style="left:0;top:0;width:{W}px;height:{H}px;border-radius:0;background:#000">'
                    + ''.join(v.replace('<video', '<video style="object-fit:contain"') for v in vids) + '</div></div>')
    else:
        callouts = []
        for j, c in enumerate(spec.get('callouts', [])):
            x, y, w, h = st.box(c['rect'], c.get('pad', 10))
            callouts.append(f'<div class="callout" id="co{j}" style="left:{x:.0f}px;top:{y:.0f}px;width:{w:.0f}px;height:{h:.0f}px;opacity:0"></div>')
            if c.get('chip'):
                callouts.append(f'<div class="chip" id="ch{j}" style="left:{x:.0f}px;top:{y - 52:.0f}px;opacity:0">{c["chip"]}</div>')
            tl.append(f'tl.fromTo("#co{j}", {{opacity:0, scale:1.04}}, {{opacity:1, scale:1, duration:.35, ease:"power3.out"}}, {c["at"]});')
            tl.append(f'tl.to("#co{j}", {{opacity:0, duration:.25, ease:"power1.in"}}, {c["until"]});')
            if c.get('chip'):
                tl.append(f'tl.fromTo("#ch{j}", {{opacity:0, y:12}}, {{opacity:1, y:0, duration:.4, ease:"back.out(1.6)"}}, {c["at"] + .12});')
                tl.append(f'tl.to("#ch{j}", {{opacity:0, duration:.25}}, {c["until"]});')
        body.append(f'<div id="cam"><div class="win" style="left:{st.left:.1f}px;top:{st.top:.1f}px;width:{st.ww:.1f}px;height:{st.wh:.1f}px">'
                    + ''.join(vids) + '</div>' + ''.join(callouts) + '</div>')

        # camera keyframes: [{"at": t, "to": "wide"|rect, "fill":..}, ...]; each move eases, holds drift slowly
        prev = st.wide()
        cams = spec.get('camera', [])
        if cams and cams[0]['at'] == 0:
            first = st.wide() if cams[0]['to'] == 'wide' else st.focus(cams[0]['to'], cams[0].get('fill', .9))
            tl.append(f'tl.set("#cam", {{x:{first["tx"]}, y:{first["ty"]}, scale:{first["z"]}}}, 0);')
            prev, cams = first, cams[1:]
        for k in cams:
            tgt = st.wide() if k['to'] == 'wide' else st.focus(k['to'], k.get('fill', .9), k.get('cx', 0), k.get('cy', 0))
            d = k.get('dur') or ease_dur(prev, tgt)
            tl.append(f'tl.to("#cam", {{x:{tgt["tx"]}, y:{tgt["ty"]}, scale:{tgt["z"]}, duration:{d:.2f}, ease:"{k.get("ease", "power3.inOut")}"}}, {k["at"]});')
            prev = tgt
        if spec.get('intro', True):
            tl.append('tl.from(".win", {opacity:0, y:40, duration:.6, ease:"power3.out"}, 0.1);')

    # captions (bottom) and headlines (top-left)
    for j, c in enumerate(spec.get('captions', [])):
        body.append(f'<div class="cap clip" id="cap{j}" data-start="{c["at"]}" data-duration="{c["until"] - c["at"]}" data-track-index="{5 + j % 2}"><span>{c["text"]}</span></div>')
        tl.append(f'tl.from("#cap{j} span", {{opacity:0, y:24, duration:.35, ease:"power3.out"}}, {c["at"]});')
    for j, c in enumerate(spec.get('heads', [])):
        body.append(f'<div class="head clip" id="hd{j}" data-start="{c["at"]}" data-duration="{c["until"] - c["at"]}" data-track-index="{7 + j % 2}">{c["text"]}</div>')
        tl.append(f'tl.from("#hd{j}", {{opacity:0, x:-30, duration:.45, ease:"expo.out"}}, {c["at"]});')

    # brand cards: mark draw-on (intro) and lockup (outro)
    for j, c in enumerate(spec.get('cards', [])):
        if c['kind'] == 'mark':
            svg = BRAND['mark'].read_text()
            vb = svg.split('viewBox="')[1].split('"')[0]
            vw, vh = (float(v) for v in vb.split()[2:])
            inner = svg[svg.index('>', svg.index('<svg')) + 1:svg.rindex('</svg>')]
            parts = inner.split('<path')
            if c.get('accent_last', True) and len(parts) > 2:
                body_paths, accent = '<path'.join(parts[:-1]), '<path' + parts[-1]
            else:
                body_paths, accent = inner, ''
            sz = int(min(W, H) * 0.32)
            body.append(f'<div class="card-scene clip" id="cd{j}" data-start="{c["at"]}" data-duration="{c["until"] - c["at"]}" data-track-index="9">'
                        f'<svg width="{sz}" height="{sz * vh / vw:.0f}" viewBox="{vb}"><defs><clipPath id="lc{j}"><rect id="lr{j}" x="0" y="{vh}" width="{vw}" height="{vh}"/></clipPath></defs>'
                        f'<g clip-path="url(#lc{j})">{body_paths}</g><g id="bar{j}">{accent}</g></svg></div>')
            tl.append(f'tl.to("#lr{j}", {{attr:{{y:0}}, duration:.9, ease:"power2.inOut"}}, {c["at"] + .15});')
            if accent:
                tl.append(f'tl.from("#bar{j}", {{x:-{vw * .55:.0f}, opacity:0, duration:.55, ease:"expo.out"}}, {c["at"] + .85});')
            if c.get('fade_out'):
                tl.append(f'tl.to("#cd{j}", {{opacity:0, duration:.3, ease:"power1.in"}}, {c["until"] - .3});')
        else:
            svg = BRAND['lockup'].read_text().replace('<svg ', f'<svg width="{int(W*0.32)}" ', 1)
            body.append(f'<div class="card-scene clip" id="cd{j}" style="opacity:0" data-start="{c["at"]}" data-duration="{c["until"] - c["at"]}" data-track-index="10">'
                        f'<div id="lk{j}">{svg}</div><div class="tag" id="tg{j}">{c.get("tag", "")}</div></div>')
            tl.append(f'tl.to("#cd{j}", {{opacity:1, duration:.35, ease:"power1.out"}}, {c["at"]});')
            tl.append(f'tl.from("#lk{j}", {{scale:.92, opacity:0, duration:.6, ease:"expo.out"}}, {c["at"] + .1});')
            tl.append(f'tl.from("#tg{j}", {{y:16, opacity:0, duration:.45, ease:"power3.out"}}, {c["at"] + .45});')
            if c.get('fade_out'):
                tl.append(f'tl.to("#cd{j}", {{opacity:0, duration:.4}}, {c["until"] - .4});')

    # hybrid: rebuilt components lifted above the footage. html = fragment file (timed elements need class="clip"),
    # tl = file of extra GSAP lines using the same `tl`. Paths are relative to project.json.
    for o in spec.get('overlays', []):
        body.append((ROOT / o['html']).read_text())
        if o.get('tl'):
            tl.extend((ROOT / o['tl']).read_text().splitlines())

    tl = [t for t in tl if t]
    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{name}</title>
<style>html,body{{margin:0;background:#000}}{css(W, H, theme)}</style></head>
<body>
<div id="root" data-composition-id="{name}" data-start="0" data-duration="{total}" data-width="{W}" data-height="{H}">
  <div class="grain"></div>
  {chr(10).join(body)}
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {{}};
    const tl = gsap.timeline({{ paused: true }});
    {chr(10).join('    ' + t for t in tl).strip()}
    window.__timelines["{name}"] = tl;
  </script>
</div>
</body></html>
"""
    (out / 'index.html').write_text(html)
    return out


if __name__ == '__main__':
    for n in sys.argv[2:] or list(SPECS):
        print(build(n, SPECS[n]))
