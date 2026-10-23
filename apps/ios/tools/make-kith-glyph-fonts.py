#!/usr/bin/env python3
"""Builds the Dynamic Island's "hop" glyph fonts from the brand SVGs in tools/art/kith-hop.

The Live Activity cannot run an animation, but a timer Text redraws every second and a font
decides what each digit looks like. So each font maps the digits 0-9 to ten poses of the hop and
hides every character of the timer but the last (a contextual `calt` rule), leaving one glyph
that steps once a second. `KithHop-Dot` is the body, `KithHop-Ghost` its ground shadow (drawn
at 30% under the same-numbered pose).

    python3 -m venv .venv && .venv/bin/pip install fonttools
    .venv/bin/python apps/ios/tools/make-kith-glyph-fonts.py

Output: apps/ios/Widgets/Resources/Fonts/KithHop-{Dot,Ghost}.ttf. Re-run only when the art changes;
the .ttf files are committed. Glyph box: 1000 x 1000 units, baseline at the bottom, ascent 1000,
descent 0, so a font of size S draws an S x S square.
"""
from pathlib import Path
from xml.etree import ElementTree

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

ROOT = Path(__file__).resolve().parent
ART = ROOT / "art" / "kith-hop"
OUT = ROOT.parent / "Widgets" / "Resources" / "Fonts"

# Digit -> hop frame (timing.json: rest 0-2, crouch 3-5, flight 6-16 with the apex at 11,
# land 17-19, settle 20-23). One digit a second, so ten poses make one 10 s hop.
FRAMES = [0, 3, 5, 8, 11, 14, 17, 19, 21, 23]
DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
# Everything a timer can print besides digits; shaped to nothing.
BLANKS = {"space": 0x20, "colon": 0x3A, "period": 0x2E, "comma": 0x2C, "ratio": 0x2236,
          "nbsp": 0xA0, "nnbsp": 0x202F, "thinsp": 0x2009, "fwcolon": 0xFF1A}
UPM = 1000


def outline(svg: Path):
    """One SVG path (a 1000 x 1000 viewBox, y down) as a TrueType glyph (y up)."""
    d = ElementTree.parse(svg).getroot().find("{http://www.w3.org/2000/svg}path").attrib["d"]
    pen = TTGlyphPen(None)
    parse_path(d, TransformPen(Cu2QuPen(pen, 1.0, reverse_direction=True), (1, 0, 0, -1, 0, UPM)))
    return pen.glyph()


def empty():
    return TTGlyphPen(None).glyph()


def build(name: str, prefix: str):
    order = [".notdef", "blank"] + list(BLANKS) + DIGITS
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    cmap = {code: n for n, code in BLANKS.items()}
    cmap.update({0x30 + i: DIGITS[i] for i in range(10)})
    fb.setupCharacterMap(cmap)
    glyphs = {".notdef": empty(), "blank": empty()}
    glyphs.update({n: empty() for n in BLANKS})
    for i, n in enumerate(DIGITS):
        glyphs[n] = outline(ART / f"{prefix}-{FRAMES[i]:02d}.svg")
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (UPM if n in DIGITS else 0, 0) for n in order})
    fb.setupHorizontalHeader(ascent=UPM, descent=0, lineGap=0)
    fb.setupNameTable({"familyName": name, "styleName": "Regular", "fullName": name,
                           "psName": name, "uniqueFontIdentifier": name})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0)
    fb.setupPost()
    # A digit followed by anything the timer prints is hidden, so only the last digit draws.
    fea = (f"@digits = [{' '.join(DIGITS)}];\n@after = [{' '.join(list(BLANKS) + DIGITS)}];\n"
           "lookup hide { sub @digits by blank; } hide;\n"
           "feature calt { sub @digits' lookup hide @after; } calt;\n")
    addOpenTypeFeaturesFromString(fb.font, fea)
    OUT.mkdir(parents=True, exist_ok=True)
    fb.font.save(OUT / f"{name}.ttf")
    print("wrote", OUT / f"{name}.ttf")


if __name__ == "__main__":
    build("KithHop-Dot", "working")
    build("KithHop-Ghost", "working-ghost")
