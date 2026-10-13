---
name: cutout
description: Remove the background from an image or make a transparent asset — rembg locally for photos, Codex edit for illustrations and line art.
---

# Cut out a subject

Pick the method by what the image is:

| Source | Method |
|---|---|
| Photo with a clear solid subject (product, person, pet, object) | **rembg**, local and free (below) |
| Illustration, line art, thin strokes, hair-fine detail, text | **Codex edit**: `imagegen.py "Remove the background; keep the subject and every line exactly" --edit IMG --transparent --out …` |
| A new asset that needs transparency | Generate it with `--transparent` from the start (`make-image`) |

rembg removes thin black lines from illustrations (tested 2026-10-13: it erased a line-drawn hand), so don't use it
for line art.

## rembg
```
uvx --from "rembg[cpu,cli]==2.0.67" rembg i IN.png OUT.png                          # default u2net model
uvx --from "rembg[cpu,cli]==2.0.67" rembg i -m isnet-general-use IN.png OUT.png     # often cleaner edges
uvx --from "rembg[cpu,cli]==2.0.67" rembg i -a IN.png OUT.png                       # alpha matting for soft edges
uvx --from "rembg[cpu,cli]==2.0.67" rembg p IN_DIR OUT_DIR                          # a whole folder
```
Models live in `~/.u2net/` (u2net and isnet-general-use are there, ~180 MB each). About 10 s per image after the
first run. Never write OUT over IN.

## Check
Put the cutout on a loud background and look at it:
`uv run <pkg>/tools/finish.py fit OUT.png --size 800x800 --contain --bg "#ff00ff" --out check.png`
Look for halos, missing parts (fingers, straps, thin lines) and leftover background. `finish.py info` shows
`"alpha": true`. If rembg fails, try `isnet-general-use`, then the Codex edit.
