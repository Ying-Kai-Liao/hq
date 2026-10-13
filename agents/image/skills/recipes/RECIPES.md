# Recipes

Ready pipelines. `img` is `<pkg>/tools/img`; `D` is the working folder
(`~/Workspace/design/<project-id>/images/`, or `~/Workspace/design/misc/images/` with no project). House style
words for prompts: "editorial illustration, flat muted colour background, flat off-white shapes, loose black
line-drawn hands, light grain, no text". Look at every output before moving on.

## Link preview (OG) card for a post
1. `img gen "<idea of the post as one object or gesture>, house style, wide 16:9, left half calm and empty for a title" --out D/<slug>-art.png`
2. `{"title": "<exact post title>", "credit": "<the credit line from shared/user.md>", "illustration": "<slug>-art.png", "align": "left"}` → D/<slug>-og.json
3. `img ig poster D/<slug>-og.json --preset og --out D/<slug>-og.png`, then `img fit D/<slug>-og.png --preset og --out D/<slug>-og.jpg --max-kb 300` if a size limit applies.

## Blog hero / cover
`img gen "<subject>, house style, wide 16:9, no text" --out D/<slug>-hero.png` → `img fit D/<slug>-hero.png --preset blog-hero --out D/<slug>-hero.webp --max-kb 400`.

## README or project tile
`img gen "<what the project does as one scene>, house style, square, no text" --n 2 --out D/<slug>-tile.png` → pick one → `img fit … --preset readme-tile --out D/<slug>-tile.webp`.

## Social post with a headline (Instagram / LinkedIn)
Art as above (portrait 4:5, top calm) → `img ig poster post.json --preset ig-portrait --out D/<slug>-post.png`.

## Carousel (3–8 slides)
One JSON per slide (slide 1: `poster` or `stat`; middle: `steps`/`list`/`compare`; last: `quote` or a CTA in
`list`), same `--preset ig-portrait` and theme → `D/<slug>-1.png` … Then `img sheet D/<slug>-*.png --cols 4 --labels --out D/<slug>-overview.jpg` to show the set.

## Chart from someone's data ("graph my spending", "chart our signups")
`workflows/SKILL.md`: ask the owner agent for a CSV → check it → `img chart quick <kind> --data D/data/x.csv --x … --y … --title … --source … --preset ig-portrait --out D/x.png`.

## Big-number card ("stats for the week", "results")
Numbers from their owner (or the user) → `stat` JSON with 1–4 `{value, label}` and a `source` → `img ig stat s.json --preset og --out D/stats.png`.

## Explainer ("how X works" as an image)
3–6 steps → `steps` JSON, optional spot illustration from `img gen` → `img ig steps how.json --preset ig-portrait --out D/how.png`.
If it is really a system with branches, use a diagram instead.

## Before / after, A vs B
`compare` JSON, 3–4 points a side, parallel wording → `img ig compare c.json --preset og --out D/compare.png`.

## Timeline / milestones
`timeline` JSON with real dates (from git log, the user, or the owner agent) → `img ig timeline t.json --preset ig-portrait --out D/timeline.png`.

## Architecture or flow diagram
`diagram/SKILL.md`: write `x.mmd` → `img diagram D/x.mmd D/x.png`. Facts from the repo or `hq:devops`.

## Isometric explainer figure ("show how a CDN cache works", "a premium technical drawing")
`anatomy-hq.md` (in skills/): make a figure folder in D, copy the kit in, start from the closest example, build with Node,
capture a PNG with `node <anatomy>/scripts/capture.mjs D/<fig>/<fig>.html --out D/<fig>.png`, look, deliver the
PNG (and the HTML if they want it interactive). Takes far longer than an infographic; say so up front.

## Market or research infographic
Ask `hq:marketing` for 3–6 figures, each with source URL and date → `stat` or `list` JSON with `source` naming
them → render. Never put a figure without a source on it.

## Transparent sticker / product cutout
New: `img gen "<object>, sticker style, transparent background" --transparent --out D/x.png`.
From a photo: `img cutout photo.jpg D/x.png`. Check on magenta: `img fit D/x.png --size 800x800 --contain --bg "#ff00ff" --out D/x-check.png`.

## Match a project's brand
Copy `tools/themes/hq.json` to `D/theme.json`, set colours and fonts (from `hq:branding` or the brand folder),
then add `--theme D/theme.json` to every `img ig` / `img chart` call.
