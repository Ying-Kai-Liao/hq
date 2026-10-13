#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow==11.3.0"]
# ///
"""finish — deterministic last steps for an image: exact sizes, formats, file size, exact text, contact sheets.

  finish.py presets                                         list platform sizes
  finish.py info IMG...                                     size, alpha, bytes
  finish.py fit IMG --preset og --out OUT [--gravity top] [--format webp] [--quality 82] [--max-kb 300]
  finish.py fit IMG --size 1600x900 --out OUT [--contain --bg "#eef0ec"]
  finish.py text IMG --out OUT --title "Exact words\\nline two" [--sub "Second line"] [--pos bottom-left] [--color "#fff"]
                [--scrim] [--font PATH] [--scale 1.0]
  finish.py sheet IMG... --out OUT [--cols 3] [--labels]    contact sheet for comparing variants

fit covers the target (crops the overflow at --gravity) unless --contain (letterbox on --bg). The output format
comes from --format or OUT's extension. --max-kb steps quality down until the file fits (jpg/webp/avif).
Never overwrites: an existing OUT becomes OUT-v2, -v3…  Prints one JSON line per output.
Run with `uv run <hq>/agents/image/tools/finish.py …` (uv fetches Pillow once into its cache).
"""
import argparse, json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

PRESETS = {k: (v['w'], v['h'], v['use']) for k, v in json.loads(
    (Path(__file__).resolve().parent / 'presets.json').read_text()).items()}
FONTS = ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc',
         '/System/Library/Fonts/Supplemental/Arial.ttf']
FMT = {'.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WEBP', '.avif': 'AVIF'}


def free_path(p):
    if not p.exists():
        return p
    i = 2
    while (q := p.with_name(f'{p.stem}-v{i}{p.suffix}')).exists():
        i += 1
    return q


def save(im, out, fmt=None, quality=85, max_kb=None):
    out = Path(out).expanduser()
    if fmt:
        out = out.with_suffix('.' + fmt.lower().replace('jpeg', 'jpg'))
    kind = FMT.get(out.suffix.lower())
    if not kind:
        sys.exit(f'finish: unsupported output type {out.suffix} (use png, jpg, webp, avif)')
    out = free_path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if kind == 'JPEG' and im.mode in ('RGBA', 'LA', 'P'):
        im = flatten(im, '#ffffff')
    q = quality
    while True:
        opts = {'optimize': True} if kind == 'PNG' else {'quality': q}
        if kind == 'JPEG':
            opts.update(optimize=True, progressive=True)
        im.save(out, kind, **opts)
        size = out.stat().st_size
        if not max_kb or kind == 'PNG' or size <= max_kb * 1024 or q <= 40:
            break
        q -= 7
    res = {'file': str(out), 'size': f'{im.width}x{im.height}', 'kb': round(size / 1024), 'format': kind.lower()}
    if kind != 'PNG':
        res['quality'] = q
    if max_kb and size > max_kb * 1024:
        res['note'] = f'still over {max_kb} KB at the lowest quality; use a smaller size or another format'
    print(json.dumps(res))


def flatten(im, bg):
    base = Image.new('RGB', im.size, bg)
    im = im.convert('RGBA')
    base.paste(im, mask=im.getchannel('A'))
    return base


def parse_size(a):
    if a.preset:
        if a.preset not in PRESETS:
            sys.exit(f'finish: unknown preset {a.preset}; see `finish.py presets`')
        return PRESETS[a.preset][:2]
    try:
        w, h = (int(x) for x in a.size.lower().split('x'))
        return w, h
    except (AttributeError, ValueError):
        sys.exit('finish: give --preset NAME or --size WxH')


def cmd_fit(a):
    im = ImageOps.exif_transpose(Image.open(a.img))
    w, h = parse_size(a)
    if a.contain:
        fitted = ImageOps.contain(im, (w, h), Image.LANCZOS)
        canvas = Image.new('RGBA' if fitted.mode == 'RGBA' else 'RGB', (w, h), a.bg)
        canvas.paste(fitted, ((w - fitted.width) // 2, (h - fitted.height) // 2),
                     fitted if fitted.mode == 'RGBA' else None)
        out = canvas
    else:
        cx, cy = {'center': (.5, .5), 'top': (.5, 0), 'bottom': (.5, 1), 'left': (0, .5), 'right': (1, .5)}[a.gravity]
        out = ImageOps.fit(im, (w, h), Image.LANCZOS, centering=(cx, cy))
    if (w > im.width or h > im.height) and not a.contain:
        print(json.dumps({'warning': f'source {im.width}x{im.height} is upscaled to {w}x{h}; it may look soft'}))
    save(out, a.out, a.format, a.quality, a.max_kb)


def font(path, px):
    for p in ([path] if path else []) + FONTS:
        try:
            return ImageFont.truetype(p, px)
        except OSError:
            continue
    return ImageFont.load_default(px)


def wrap(draw, text, f, width):
    """Greedy wrap to width; a literal newline (or \\n typed on the command line) forces a break."""
    if '\n' in text.replace('\\n', '\n'):
        return [l for part in text.replace('\\n', '\n').split('\n') for l in wrap(draw, part, f, width)]
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if draw.textlength(t, font=f) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    return lines + ([cur] if cur else [])


def cmd_text(a):
    im = ImageOps.exif_transpose(Image.open(a.img)).convert('RGBA')
    W, H = im.size
    pad = round(min(W, H) * 0.07)
    tf = font(a.font, round(H * 0.085 * a.scale))
    sf = font(a.font, round(H * 0.042 * a.scale))
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    maxw = W - 2 * pad if a.pos.endswith('center') else round(W * 0.62)
    tl = wrap(d, a.title, tf, maxw)
    sl = wrap(d, a.sub, sf, maxw) if a.sub else []
    lh_t, lh_s = round(tf.size * 1.12), round(sf.size * 1.35)
    block_h = len(tl) * lh_t + (round(sf.size * 0.6) + len(sl) * lh_s if sl else 0)
    v, hz = a.pos.split('-')
    y = {'top': pad, 'middle': (H - block_h) // 2, 'bottom': H - pad - block_h}[v]
    if a.scrim:
        top = max(0, y - pad) if v != 'top' else 0
        bot = min(H, y + block_h + pad) if v != 'bottom' else H
        for yy in range(top, bot):  # soft gradient towards the text
            t = (yy - top) / max(1, bot - top)
            alpha = round(150 * (t if v == 'bottom' else 1 - t if v == 'top' else 1 - abs(t - .5) * 2))
            d.line([(0, yy), (W, yy)], fill=(0, 0, 0, alpha))
    for lines, f, lh in ((tl, tf, lh_t), (sl, sf, lh_s)):
        if lines is sl and sl:
            y += round(sf.size * 0.6)
        for line in lines:
            lw = d.textlength(line, font=f)
            x = {'left': pad, 'center': (W - lw) / 2, 'right': W - pad - lw}[hz]
            d.text((x, y), line, font=f, fill=a.color)
            y += lh
    out = Image.alpha_composite(im, layer)
    save(out, a.out, a.format, a.quality, a.max_kb)


def cmd_sheet(a):
    ims = [ImageOps.exif_transpose(Image.open(p)).convert('RGB') for p in a.imgs]
    cell = 480
    cols = min(a.cols, len(ims))
    rows = -(-len(ims) // cols)
    gap, lab = 16, (34 if a.labels else 0)
    sheet = Image.new('RGB', (cols * cell + (cols + 1) * gap, rows * (cell + lab) + (rows + 1) * gap), '#e9ebe7')
    d, f = ImageDraw.Draw(sheet), font(None, 20)
    for i, (im, p) in enumerate(zip(ims, a.imgs)):
        r, c = divmod(i, cols)
        x, y = gap + c * (cell + gap), gap + r * (cell + lab + gap)
        t = ImageOps.contain(im, (cell, cell), Image.LANCZOS)
        sheet.paste(t, (x + (cell - t.width) // 2, y + (cell - t.height) // 2))
        if a.labels:
            d.text((x, y + cell + 8), f'{i + 1}  {Path(p).name}', font=f, fill='#3a403c')
    save(sheet, a.out, None, 85, None)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('presets')
    p = sub.add_parser('info'); p.add_argument('imgs', nargs='+')
    outs = argparse.ArgumentParser(add_help=False)
    outs.add_argument('--out', required=True); outs.add_argument('--format')
    outs.add_argument('--quality', type=int, default=85); outs.add_argument('--max-kb', type=int)
    p = sub.add_parser('fit', parents=[outs]); p.add_argument('img')
    p.add_argument('--preset'); p.add_argument('--size')
    p.add_argument('--gravity', default='center', choices=['center', 'top', 'bottom', 'left', 'right'])
    p.add_argument('--contain', action='store_true'); p.add_argument('--bg', default='#ffffff')
    p = sub.add_parser('text', parents=[outs]); p.add_argument('img')
    p.add_argument('--title', required=True); p.add_argument('--sub')
    p.add_argument('--pos', default='bottom-left',
                   choices=[f'{v}-{h}' for v in ('top', 'middle', 'bottom') for h in ('left', 'center', 'right')])
    p.add_argument('--color', default='#ffffff'); p.add_argument('--scrim', action='store_true')
    p.add_argument('--font'); p.add_argument('--scale', type=float, default=1.0)
    p = sub.add_parser('sheet'); p.add_argument('imgs', nargs='+'); p.add_argument('--out', required=True)
    p.add_argument('--cols', type=int, default=3); p.add_argument('--labels', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'presets':
        for k, (w, h, use) in PRESETS.items():
            print(f'{k:16} {w}x{h:<6} {use}')
    elif a.cmd == 'info':
        for p in a.imgs:
            im = Image.open(p)
            print(json.dumps({'file': p, 'size': f'{im.width}x{im.height}', 'mode': im.mode,
                              'alpha': 'A' in im.getbands(), 'kb': round(Path(p).stat().st_size / 1024)}))
    else:
        {'fit': cmd_fit, 'text': cmd_text, 'sheet': cmd_sheet}[a.cmd](a)


if __name__ == '__main__':
    main()
