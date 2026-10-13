#!/usr/bin/env python3
"""infographic — exact-text infographics from a small JSON file, rendered by headless Chrome. stdlib only.

  infographic.py TEMPLATE content.json --out DIR/name.png [--preset ig-portrait | --size WxH] [--theme hq|FILE]
  infographic.py templates                     list templates and the JSON each one takes

Every template takes: title, subtitle, source ("Source: …", shown small at the bottom), credit (e.g. "Name ·
example.com"), illustration (path to an image, e.g. from imagegen.py), accent (colour override).
Writes OUT.png and OUT.html (edit the HTML and re-render with `--html OUT.html` for small fixes). Never overwrites.
Prints one JSON line.
"""
import argparse, base64, html, json, mimetypes, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render  # noqa: E402

TEMPLATES = {
    'stat': ('1–4 big numbers', '{"stats": [{"value": "42%", "label": "of tasks finished without a question"}]}'),
    'steps': ('a process, 3–6 steps in order', '{"steps": [{"title": "Brief", "text": "what it is for"}]}'),
    'compare': ('two options side by side', '{"left": {"title": "Before", "points": ["…"]}, "right": {"title": "After", "points": ["…"]}}'),
    'timeline': ('dated events, 3–7', '{"events": [{"date": "2026-03", "title": "Launch", "text": "…"}]}'),
    'list': ('a ranked or grouped list, 3–8 items', '{"numbered": true, "items": [{"title": "…", "text": "…"}]}'),
    'quote': ('a pull quote card', '{"quote": "…", "author": "Name, role"}'),
    'chart': ('a chart (SVG from chart.py) with headline and takeaway', '{"chart": "path/to/chart.svg", "takeaway": "…"}'),
    'poster': ('a big illustration with a headline over calm space', '{"illustration": "art.png", "align": "left|center"}'),
}


def esc(s):
    return html.escape(str(s or ''))


def data_uri(path):
    p = Path(path).expanduser()
    if not p.is_file():
        render.die(f'no such file: {path}')
    mime = mimetypes.guess_type(p.name)[0] or 'image/png'
    return f'data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}'


def body(tpl, c, t):
    s = t['series']
    if tpl == 'stat':
        stats = c.get('stats') or render.die('stat needs "stats"')
        cells = ''.join(f'<div class="stat"><div class="big" style="color:{s[i % len(s)]}">{esc(x["value"])}</div>'
                        f'<div class="lbl">{esc(x.get("label"))}</div></div>' for i, x in enumerate(stats))
        return f'<div class="stats n{len(stats)}">{cells}</div>'
    if tpl == 'steps':
        steps = c.get('steps') or render.die('steps needs "steps"')
        return '<ol class="steps">' + ''.join(
            f'<li><span class="num" style="background:{s[i % len(s)]}">{i + 1}</span><div><h3>{esc(x["title"])}</h3>'
            f'<p>{esc(x.get("text"))}</p></div></li>' for i, x in enumerate(steps)) + '</ol>'
    if tpl == 'compare':
        def side(x, col):
            pts = ''.join(f'<li>{esc(p)}</li>' for p in x.get('points', []))
            return f'<div class="side"><h3 style="border-color:{col}">{esc(x.get("title"))}</h3><ul>{pts}</ul></div>'
        return f'<div class="compare">{side(c.get("left", {}), s[0])}{side(c.get("right", {}), s[1])}</div>'
    if tpl == 'timeline':
        ev = c.get('events') or render.die('timeline needs "events"')
        return '<div class="timeline">' + ''.join(
            f'<div class="ev"><span class="dot" style="background:{s[i % len(s)]}"></span><div class="date">{esc(x.get("date"))}</div>'
            f'<h3>{esc(x["title"])}</h3><p>{esc(x.get("text"))}</p></div>' for i, x in enumerate(ev)) + '</div>'
    if tpl == 'list':
        items = c.get('items') or render.die('list needs "items"')
        tag = 'ol' if c.get('numbered', True) else 'ul'
        return f'<{tag} class="list">' + ''.join(
            f'<li><h3>{esc(x["title"])}</h3><p>{esc(x.get("text"))}</p></li>' for x in items) + f'</{tag}>'
    if tpl == 'quote':
        return (f'<blockquote class="quote"><p>{esc(c.get("quote") or render.die("quote needs quote"))}</p>'
                f'<cite>{esc(c.get("author"))}</cite></blockquote>')
    if tpl == 'chart':
        svg = Path(c.get('chart') or render.die('chart needs "chart" (an SVG from chart.py)')).expanduser().read_text()
        take = f'<p class="takeaway">{esc(c["takeaway"])}</p>' if c.get('takeaway') else ''
        return f'<div class="chartbox">{svg}</div>{take}'
    if tpl == 'poster':
        return ''
    render.die(f'unknown template {tpl}')


def page(tpl, c, t, w, h):
    ill = c.get('illustration')
    accent = c.get('accent') or t['accent']
    poster = tpl == 'poster'
    if poster and not ill:
        render.die('poster needs "illustration"')
    ill_html = '' if poster or not ill else f'<img class="ill" src="{data_uri(ill)}" alt="">'
    bg = f'background:url({data_uri(ill)}) center/cover;' if poster else ''
    wide = w / h > 1.25
    # short lists on tall canvases get bigger type instead of empty space
    n = len(c.get('steps') or c.get('items') or c.get('events') or [])
    zoom = 1 if wide or not n else max(1, min(1.45, 6 / n * (.75 if ill else 1)))
    foot = ' · '.join(x for x in (esc(c.get('source')), esc(c.get('credit'))) if x)
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>
:root{{--bg:{t['bg']};--panel:{t['panel']};--ink:{t['ink']};--muted:{t['muted']};--line:{t['line']};--accent:{accent};
--fd:{t['font_display']};--fb:{t['font_body']};--fm:{t['font_mono']};--u:{min(w, h) / 100:.2f}px}}
*{{box-sizing:border-box}} html,body{{margin:0;width:{w}px;height:{h}px;overflow:hidden}}
body{{background:var(--bg);{bg}color:var(--ink);font:400 calc(var(--u)*2.9)/1.35 var(--fb);
  padding:calc(var(--u)*6.5);display:flex;flex-direction:column;gap:calc(var(--u)*3.5)}}
header{{display:grid;gap:calc(var(--u)*1.4);max-width:{'62%' if poster or (wide and ill) else '100%'}}}
h1{{font:700 calc(var(--u)*{'7.2' if poster else '6'})/1.04 var(--fd);margin:0;letter-spacing:-.015em;text-wrap:balance}}
.sub{{font-size:calc(var(--u)*3);color:var(--muted);margin:0;text-wrap:pretty}}
main{{flex:1;min-height:0;display:flex;flex-direction:{'row' if wide else 'column'};gap:calc(var(--u)*4);align-items:stretch}}
main>.content{{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:calc(var(--u)*2)}}
main>.content>.steps,main>.content>.list,main>.content>.timeline{{zoom:{zoom:.2f}}}
.ill{{{'width:38%;height:100%' if wide else 'width:100%;height:32%'};object-fit:contain;flex:none}}
footer{{font:400 calc(var(--u)*1.9)/1.3 var(--fm);color:var(--muted);display:flex;justify-content:space-between;gap:2em}}
h3{{font:600 calc(var(--u)*3.5)/1.15 var(--fd);margin:0}} p{{margin:0}}
.stats{{display:grid;gap:calc(var(--u)*3);grid-template-columns:repeat({'var(--n)' if wide else '1'},1fr)}}
.stats.n1{{--n:1}}.stats.n2{{--n:2}}.stats.n3{{--n:3}}.stats.n4{{--n:{4 if wide else 2}}}
{'.stats.n4{grid-template-columns:repeat(2,1fr)}' if not wide else ''}
.stat{{background:var(--panel);padding:calc(var(--u)*3);border-radius:calc(var(--u)*1)}}
.big{{font:700 calc(var(--u)*{'15' if wide else '12'})/1 var(--fd);letter-spacing:-.03em;font-variant-numeric:tabular-nums}}
.lbl{{margin-top:calc(var(--u)*1.4);font-size:calc(var(--u)*3.1)}}
.steps,.list{{list-style:none;margin:0;padding:0;display:grid;gap:calc(var(--u)*2.4)}}
.steps li{{display:grid;grid-template-columns:auto 1fr;gap:calc(var(--u)*2.4);align-items:start}}
.num{{width:calc(var(--u)*6.4);height:calc(var(--u)*6.4);border-radius:50%;display:grid;place-items:center;
  color:var(--panel);font:700 calc(var(--u)*3.2)/1 var(--fd)}}
.steps p,.list p,.timeline p{{color:var(--muted);margin-top:calc(var(--u)*.5)}}
.list{{counter-reset:i}} ol.list li{{counter-increment:i;display:grid;grid-template-columns:calc(var(--u)*7) 1fr;align-items:baseline}}
ol.list li::before{{content:counter(i,decimal-leading-zero);font:700 calc(var(--u)*3.6)/1 var(--fd);color:var(--accent)}}
ol.list li>*{{grid-column:2}} ul.list li{{border-left:calc(var(--u)*.6) solid var(--accent);padding-left:calc(var(--u)*2)}}
.compare{{display:grid;grid-template-columns:1fr 1fr;gap:calc(var(--u)*3)}}
.side{{background:var(--panel);padding:calc(var(--u)*3);border-radius:calc(var(--u)*1)}}
.side h3{{border-bottom:calc(var(--u)*.6) solid;padding-bottom:calc(var(--u)*1.2);margin-bottom:calc(var(--u)*1.6)}}
.side ul{{margin:0;padding-left:1.1em;display:grid;gap:calc(var(--u)*1.2)}}
.timeline{{display:grid;gap:calc(var(--u)*2.6);border-left:calc(var(--u)*.4) solid var(--line);padding-left:calc(var(--u)*4);margin-left:calc(var(--u)*1.4)}}
.ev{{position:relative}} .dot{{position:absolute;left:calc(var(--u)*-5.6);top:calc(var(--u)*.6);width:calc(var(--u)*2.8);height:calc(var(--u)*2.8);border-radius:50%}}
.date{{font:500 calc(var(--u)*2.1)/1 var(--fm);color:var(--muted);margin-bottom:calc(var(--u)*.6)}}
.quote{{margin:0;border-left:calc(var(--u)*1) solid var(--accent);padding-left:calc(var(--u)*4)}}
.quote p{{font:500 calc(var(--u)*5.4)/1.2 var(--fd);text-wrap:balance}} .quote cite{{display:block;margin-top:calc(var(--u)*2.5);font-style:normal;color:var(--muted)}}
.chartbox{{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}} .chartbox svg{{max-width:100%;max-height:100%;height:auto}}
.takeaway{{font:600 calc(var(--u)*3)/1.3 var(--fd);border-left:calc(var(--u)*.8) solid var(--accent);padding-left:calc(var(--u)*2)}}
{'body.t-poster header{margin-top:auto}' if c.get('align') != 'top' else ''}
{'body.t-poster{justify-content:flex-end}' if poster else ''}
{'header{background:color-mix(in srgb,var(--bg) 88%,transparent);padding:calc(var(--u)*3);border-radius:calc(var(--u)*1)}' if poster else ''}
{render.grain_css(t)}
</style></head><body class="t-{tpl}">
<header><h1>{esc(c.get('title'))}</h1>{f'<p class="sub">{esc(c["subtitle"])}</p>' if c.get('subtitle') else ''}</header>
{'' if poster else f'<main><div class="content">{body(tpl, c, t)}</div>{ill_html}</main>'}
{f'<footer><span>{foot}</span></footer>' if foot else ''}
</body></html>'''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('template')
    ap.add_argument('content', nargs='?')
    ap.add_argument('--out')
    ap.add_argument('--preset')
    ap.add_argument('--size')
    ap.add_argument('--theme')
    ap.add_argument('--html', help='re-render an edited OUT.html instead of building from JSON')
    a = ap.parse_args()
    if a.template == 'templates':
        for k, (use, ex) in TEMPLATES.items():
            print(f'{k:9} {use}\n          {ex}')
        return
    w, h = render.size(a.preset, a.size)
    if a.html:
        out = render.html_to_png(Path(a.html).read_text(), w, h, a.out or Path(a.html).with_suffix('.png'))
    else:
        if not (a.content and a.out):
            render.die('give content.json and --out')
        if a.template not in TEMPLATES:
            render.die(f'unknown template {a.template}; see `infographic.py templates`')
        c = json.loads(Path(a.content).expanduser().read_text())
        base = Path(a.content).expanduser().parent
        for k in ('illustration', 'chart'):  # paths in the JSON are relative to the JSON file
            if c.get(k) and not Path(c[k]).expanduser().is_absolute():
                c[k] = str(base / c[k])
        out = render.html_to_png(page(a.template, c, render.theme(a.theme), w, h), w, h, a.out)
    print(json.dumps({'ok': True, 'file': str(out), 'html': str(out.with_suffix('.html')), 'size': f'{w}x{h}'}))


if __name__ == '__main__':
    main()
