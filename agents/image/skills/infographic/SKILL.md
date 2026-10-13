---
name: infographic
description: Infographics and cards with exact text in the house style — big numbers, steps, comparison, timeline, list, quote, chart card, illustrated poster — rendered from a small JSON file, optionally with a generated illustration.
---

# Make an infographic

Command: `<pkg>/tools/img ig TEMPLATE content.json --out F.png --preset P`. `img templates` lists the
templates and their JSON. Text is rendered as text, so it is always spelled exactly.

| Template | Use for | Content |
|---|---|---|
| `stat` | 1–4 headline numbers | `stats: [{value, label}]` |
| `steps` | a process in order (3–6) | `steps: [{title, text}]` |
| `compare` | two options, before/after | `left/right: {title, points: []}` |
| `timeline` | dated events (3–7) | `events: [{date, title, text}]` |
| `list` | rules, tips, a ranking (3–8) | `items: [{title, text}]`, `numbered` |
| `quote` | a pull quote | `quote`, `author` |
| `chart` | a chart card (`img chart` makes these) | `chart: path.svg`, `takeaway` |
| `poster` | big illustration + headline (covers, OG cards) | `illustration` (required), `align` |

All take `title`, `subtitle`, `source`, `credit` (for the user's own posts, the credit line in `shared/user.md`), `illustration`
(a PNG, e.g. from `img gen`; paths are relative to the JSON file), `accent`.

## Steps
1. Get the facts. Numbers and claims come from a source (the user, a file, or a helper agent: see `workflows/`).
   Write the content JSON in the working folder next to the output.
2. Keep words short: titles ≤ 8 words, labels ≤ 8 words, step text ≤ 12 words. Cut rather than shrink.
3. Optional illustration: `img gen` a small spot illustration in the house style ("single object, flat muted
   colour, off-white shapes, loose black line, no text, plain background") and put its path in `illustration`.
   For `poster`, generate wide or tall to match the preset, and ask for calm empty space where the title goes.
4. Render: `img ig steps how.json --preset ig-portrait --out …/how.png`. Common sizes: `ig-portrait` (social),
   `og` (link preview), `slide`, `a4-portrait` (print), `readme-tile`.
5. Look at it. Fix wording in the JSON and re-render. For a one-off tweak (spacing, a colour), edit `F.html` and
   re-render it: `img ig shot --html F.html --preset P --out F.png`.
6. Carousels: one JSON per slide, same preset and theme, numbered files (`carousel-1.png`…).

## Brand
The house theme is `tools/themes/hq.json` (from the user's taste). For a project, copy it to
`~/Workspace/design/<id>/images/theme.json`, change colours/fonts from the project's brand (ask `hq:branding`
or read the brand folder), and pass `--theme` that file to every `img ig` and `img chart` call.
