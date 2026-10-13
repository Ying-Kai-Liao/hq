# Using anatomy inside hq (read before SKILL.md)

Upstream: github.com/wheresryan22/anatomy, MIT, fetched into `skills/anatomy/` at the commit pinned in the image
agent's `skills.json` (hq-pkg fetch). To update: change that ref. Never edit files in `skills/anatomy/`.

- **When:** the user or a caller wants an isometric figure, a "premium" technical drawing, or an interactive
  explainer of how something works. For plain boxes-and-arrows use `diagram/`; for a quick explainer card use
  `infographic/`. A figure takes much longer (an hour is normal); say so before starting.
- **Where:** each figure gets its own folder in the working folder: `~/Workspace/design/<id>/images/<fig>/`.
- **Self-contained:** `skills/anatomy/` moves with every agent version, so never import the kit from here.
  Copy it in first: `cp -R <package>/skills/anatomy/kit <figure folder>/kit`, and import `./kit/iso-kit.mjs` in the
  figure's `build.mjs`. Examples import `../../kit/…`; change that when you copy one.
- **Build and look:** `node <figure folder>/build.mjs` (add `--light` for the light theme; `--audit` when it has
  pipes or round parts), then `node <package>/skills/anatomy/scripts/capture.mjs <page>.html --out <fig>.png`
  (`--theme light`, `--width 390` for a phone check). Read every PNG, as SKILL.md says.
- **House style:** prefer the light theme with the house palette from `tools/themes/hq.json` unless the
  destination is a dark page.
- **Facts:** a figure of a real system shows real parts and real numbers, from the repo, `hq:devops` or the user.
- **Never publish to the Anatomy community gallery** (`references/publish.md`) unless the user explicitly asks
  for that figure, and then still show the dry-run plan and wait for their yes. It is public.
- Deliver the PNG; give the HTML too when they want it interactive. React/Next components only when the user
  asks for them in a repo.
