---
name: make-image
description: Generate, edit, vary or cut out a raster image with tools/imagegen.py, check it, and deliver the file.
---

# Make an image

Tool: `/usr/bin/python3 <pkg>/tools/imagegen.py` (stdlib; Homebrew Python's expat is broken, use
`/usr/bin/python3`). One call takes 45–80 s. It prints one JSON line with the saved `files`.

```
imagegen.py "<prompt>" --out DIR/name.png                 # new image
imagegen.py "<prompt>" --out DIR/name.png --n 3           # 3 variants of one prompt (max 4) → name-1..3.png
imagegen.py "<prompt>" --out DIR/name.png --ref a.png     # use a.png for style/composition (repeatable)
imagegen.py "<what to change; what to keep>" --edit src.png --out src.png    # saved as src-v2.png
imagegen.py "<prompt>" --out DIR/name.png --transparent  # real alpha (PNG colour type 6)
```
Different assets get different calls (run them in parallel with `&` … `wait`); `--n` is only for variants.

## 1. Brief
Fill what you can from the request, the project (brand files, DESIGN.md, the caller's notes) and `shared/user.md`:
use, size/aspect, exact text, style, avoid list, references. Ask only for something that blocks a good result.

## 2. Prompt
For anything beyond a simple image, read `references/prompting.md` (principles, per-use-case tips) and take
a recipe from `references/sample-prompts.md` (website heroes, blog headers, game assets, textures, edits,
character consistency).

Write a short labelled spec; include only lines that help:
```
Use case: <illustration-story | photorealistic-natural | product-mockup | ads-marketing | infographic-diagram | stylized-concept | ui-mockup | …>
Asset: <where it's used, e.g. blog hero 16:9, Instagram post 4:5, app store tile>
Subject / Scene / Style / Composition / Lighting / Palette / Texture: …
Text (verbatim): "…"        ← only short words; exact headlines go on afterwards with finish.py text
Avoid: …
```
- Aspect comes from the prompt: say "square", "landscape 3:2", "portrait 2:3", "wide 16:9". Outputs are about
  1254×1254, 1536×1024 or 1024×1536. For an exact size, finish it with `finish.py fit` (see `finish-image`).
- Edits: name the one change and list what must stay ("keep background, grain, size, position unchanged").
- Don't add objects, slogans, brands or colours the brief didn't imply.

## 3. Generate and look
Save to `~/Workspace/design/<project-id>/images/<slug>.png`. Read every output file and check: subject, style,
composition, text spelled exactly, avoid list, artefacts (hands, extra fingers, warped text, seams). For a cutout,
check alpha with `sips -g hasAlpha`. Fix with one targeted change per round; stop after 3 rounds and report what
still isn't right rather than burning time.

## 4. Finish
Exact sizes, formats, file-size limits and exact text: `finish-image/SKILL.md`. Cutouts: `cutout/SKILL.md`.
To show variants together, make a contact sheet with `finish.py sheet … --labels`.

## 5. Deliver
- To the user: show the best one or two (with `hq-send --caption "…" FILE...` when the task came from Discord or
  the phone), say which you recommend and why.
- To a calling agent: return the file paths, the final prompt, and anything that didn't come out right.
- Copy into a repo only when asked, as a new file name (never over an existing asset).
- Write the final prompt and any style that worked into `memory/projects/<ID>.md`, so the next image in that
  project matches.

## If the tool fails
- `codex CLI not found` / auth errors: tell the user to run `! codex login` (ChatGPT sign-in). Don't try other
  providers or API keys without asking: they cost money.
- `no image produced`: the reply is in the error; usually a refused prompt. Rephrase once, then report.
