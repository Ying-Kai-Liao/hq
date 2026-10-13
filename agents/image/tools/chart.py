#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["vl-convert-python==1.6.0"]
# ///
"""chart — data charts in the house style, rendered locally (Vega-Lite, no browser for the chart itself).

Quick charts from a CSV or JSON file:
  chart.py quick bar|hbar|line|area|donut|scatter --data f.csv --x COL --y COL [--color COL] [--sort desc|asc]
           [--title "…"] [--subtitle "…"] [--source "Source: …"] [--takeaway "…"] [--credit "…"]
           [--format "$,.0f"] [--preset ig-portrait|og|…] [--theme hq|FILE] --out DIR/name.png
Any Vega-Lite chart:
  chart.py spec spec.json [same text/size options] --out DIR/name.png

Output: a finished card (title, subtitle, chart, takeaway, source) as PNG + HTML, via infographic.py's chart
template; --svg-only writes just the chart as SVG. The data is embedded exactly as given: this tool never
invents, rounds or drops values. Prints one JSON line.
"""
import argparse, csv, json, subprocess, sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import render  # noqa: E402
import vl_convert as vlc  # noqa: E402


def load(path):
    p = Path(path).expanduser()
    if p.suffix.lower() == '.json':
        rows = json.loads(p.read_text())
        return rows['values'] if isinstance(rows, dict) else rows
    with p.open(newline='') as f:
        rows = list(csv.DictReader(f))
    for r in rows:  # numbers stay numbers; "1,234" and "$12" are parsed, everything else stays text
        for k, v in r.items():
            s = (v or '').replace(',', '').replace('$', '').replace('%', '').strip()
            try:
                r[k] = int(s) if s.lstrip('-').isdigit() else float(s)
            except ValueError:
                pass
    return rows


def config(t, u):
    fs = round(u * 2.3)
    return {
        'background': None, 'view': {'stroke': None},
        'font': t['font_body'].split(',')[0],
        'range': {'category': t['series']},
        'mark': {'color': t['series'][0]},
        'bar': {'cornerRadiusEnd': 3},
        'line': {'strokeWidth': max(2.5, u * .5), 'strokeCap': 'round'},
        'point': {'size': round(u * u * 2.5), 'filled': True},
        'axis': {'labelColor': t['muted'], 'titleColor': t['muted'], 'labelFontSize': fs, 'titleFontSize': fs,
                 'titleFontWeight': 'normal', 'domainColor': t['line'], 'tickColor': t['line'],
                 'gridColor': t['line'], 'gridOpacity': .7, 'labelPadding': 8, 'titlePadding': 12},
        'axisX': {'grid': False}, 'axisY': {'domain': False, 'ticks': False},
        'legend': {'labelColor': t['ink'], 'titleColor': t['muted'], 'labelFontSize': fs, 'titleFontSize': fs, 'symbolSize': fs * 9,
                   'orient': 'top', 'symbolType': 'circle', 'title': None},
        'text': {'color': t['ink'], 'fontSize': fs},
    }


def quick(a, rows):
    x, y, fmt = a.x, a.y, a.format
    yq = {'field': y, 'type': 'quantitative', 'title': None, **({'axis': {'format': fmt}} if fmt else {})}
    sort = {'desc': '-y', 'asc': 'y'}.get(a.sort)
    color = {'field': a.color, 'type': 'nominal'} if a.color else None
    kind = a.kind
    if kind == 'donut':
        r = min(a.cw, a.ch) / 2 - a.u * 7
        enc = {'theta': {'field': y, 'type': 'quantitative', 'stack': True},
               'color': {'field': x, 'type': 'nominal', 'sort': None}, 'order': {'field': '__i'}}
        for i, row in enumerate(a.rows):
            row['__i'] = i
        return {'layer': [{'mark': {'type': 'arc', 'innerRadius': r * .58, 'outerRadius': r, 'padAngle': .012}},
                          {'mark': {'type': 'text', 'radius': r + a.u * 3.6, 'fontWeight': 'bold'},
                           'encoding': {'text': {'field': y, 'type': 'quantitative',
                                                 **({'format': fmt} if fmt else {})}}}],
                'encoding': enc}
    if kind == 'hbar':
        enc = {'y': {'field': x, 'type': 'nominal', 'title': None, 'sort': {'desc': '-x', 'asc': 'x'}.get(a.sort)},
               'x': {**yq, 'axis': {'grid': False, 'labels': False, 'domain': False, 'ticks': False}}}
        if color:
            enc['color'] = color
        label = {'mark': {'type': 'text', 'align': 'left', 'dx': 6},
                 'encoding': {'text': {'field': y, 'type': 'quantitative', **({'format': fmt} if fmt else {})}}}
        return {'layer': [{'mark': 'bar'}, label], 'encoding': enc}
    xtype = 'temporal' if a.time else ('ordinal' if kind in ('line', 'area') else 'nominal')
    enc = {'x': {'field': x, 'type': xtype, 'title': None, 'axis': {'labelAngle': 0}, 'sort': sort if kind == 'bar' else None},
           'y': yq}
    if color:
        enc['color'] = color
    mark = {'bar': 'bar', 'line': {'type': 'line', 'point': True}, 'scatter': 'point',
            'area': {'type': 'area', 'opacity': .85, 'line': True}}[kind]
    return {'mark': mark, 'encoding': enc}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mode', choices=['quick', 'spec'])
    ap.add_argument('arg', help='chart kind for quick, spec.json for spec')
    ap.add_argument('--data'); ap.add_argument('--x'); ap.add_argument('--y'); ap.add_argument('--color')
    ap.add_argument('--sort', choices=['desc', 'asc']); ap.add_argument('--time', action='store_true')
    ap.add_argument('--format', help='d3 number format for values, e.g. "$,.0f" or ".0%"')
    for k in ('title', 'subtitle', 'source', 'takeaway', 'credit'):
        ap.add_argument(f'--{k}')
    ap.add_argument('--preset'); ap.add_argument('--size'); ap.add_argument('--theme')
    ap.add_argument('--svg-only', action='store_true'); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    t = render.theme(a.theme)
    w, h = render.size(a.preset, a.size)
    # free area inside the card: padding, title block, takeaway and footer (matches infographic.py's chart layout)
    a.u = min(w, h) / 100
    head = a.u * (6.2 + (4.1 if a.subtitle else 0) + 3.5) * (2 if a.title and len(a.title) * a.u * 3.3 > w * .9 else 1)
    a.cw = round(w - 13 * a.u)
    a.ch = round(h - 13 * a.u - head - (a.u * 7 if a.takeaway else 0) - (a.u * 5 if a.source or a.credit else 0))

    if a.mode == 'quick':
        a.kind = a.arg
        if a.kind not in ('bar', 'hbar', 'line', 'area', 'donut', 'scatter'):
            render.die('quick kinds: bar hbar line area donut scatter')
        if not (a.data and a.x and a.y):
            render.die('quick needs --data, --x and --y')
        rows = a.rows = load(a.data)
        missing = [c for c in (a.x, a.y, a.color) if c and rows and c not in rows[0]]
        if missing:
            render.die(f'columns not in data: {missing}; have {list(rows[0])}')
        spec = quick(a, rows)
        spec['data'] = {'values': rows}
    else:
        spec = json.loads(Path(a.arg).expanduser().read_text())
        if a.data:
            spec['data'] = {'values': load(a.data)}

    spec.setdefault('width', a.cw)
    spec.setdefault('height', a.ch)
    spec.setdefault('autosize', {'type': 'fit', 'contains': 'padding'})
    spec['config'] = {**config(t, a.u), **spec.get('config', {})}
    spec.setdefault('$schema', 'https://vega.github.io/schema/vega-lite/v5.json')
    try:
        svg = vlc.vegalite_to_svg(json.dumps(spec))
    except Exception as e:  # vl-convert reports spec errors as plain exceptions
        render.die(f'Vega-Lite error: {e}')

    out = render.free_path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    svg_path = out.with_suffix('.svg')
    svg_path.write_text(svg)
    (out.with_suffix('.vl.json')).write_text(json.dumps(spec, indent=1))
    if a.svg_only:
        print(json.dumps({'ok': True, 'file': str(svg_path), 'spec': str(out.with_suffix('.vl.json'))}))
        return
    content = {'chart': str(svg_path.resolve()), **{k: getattr(a, k) for k in ('title', 'subtitle', 'source', 'takeaway', 'credit')
                                          if getattr(a, k)}}
    cj = out.with_suffix('.content.json')
    cj.write_text(json.dumps(content, indent=1))
    cmd = [sys.executable, str(TOOLS / 'infographic.py'), 'chart', str(cj), '--out', str(out), '--size', f'{w}x{h}']
    if a.theme:
        cmd += ['--theme', a.theme]
    r = subprocess.run(cmd, capture_output=True, text=True)
    res = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {'ok': False, 'error': r.stderr[-300:]}
    res.update(svg=str(svg_path), spec=str(out.with_suffix('.vl.json')))
    print(json.dumps(res))


if __name__ == '__main__':
    main()
