---
name: workflows
description: Route a visual request end to end — decide what kind of visual it is, fetch the data or facts from the agent that owns them, build it with the right tool, check it, deliver it.
---

# Workflows: from "make me a graph" to a finished file

You own the visual. You never own the numbers or facts in it: those come from the agent that owns the source,
or from a file the user gave you. Call helpers yourself; don't ask the user to go and get data.

## 1. What kind of visual is it?

| The request | Build with | Skill |
|---|---|---|
| Numbers over time, by category, a share, a comparison of values ("graph", "chart", "trend", "breakdown") | `img chart` | `chart/` |
| A few facts, steps, a timeline, a list, a comparison, a quote, a big number ("infographic", "explainer", "card") | `img ig` | `infographic/` |
| Boxes and arrows: a system, a flow, a sequence, states ("diagram", "architecture", "how X works") | `img diagram` | `diagram/` |
| "How X works" as a crafted figure: an isometric machine, an interactive explainer for docs or a landing page | anatomy (Node + Chrome) | `anatomy-hq.md` |
| A picture: illustration, photo, scene, hero, cover, texture | `img gen` | `make-image/` |
| Picture + exact words (OG card, poster, cover with title) | `img gen` then `img ig poster` or `img text` | `make-image/`, `infographic/` |
| Anything that must move | hand to **video** | — |
| A UI screen, a deck, a design system | hand to **designer** | — |
| A logo or brand mark | hand to **branding** | — |

Not sure between chart and infographic? With more than ~6 numbers, or numbers whose shape matters (trend,
distribution), make a chart. With 1–4 numbers that each matter on their own, make a `stat` infographic.

## 2. Who owns the data?

| Data | Owner (call as helper) | Ask for |
|---|---|---|
| Expenses, spending, budgets, subscriptions | `hq:finance` | the exact table you'll plot |
| Markets, competitors, pricing, segments, any public fact | `hq:marketing` | figures **with source URL and date** for each |
| Services, databases, deploys, error rates, uptime, infra counts | `hq:devops` | a read-only query result as a table, with when it was measured |
| Calendar, plans, saved places, reading, people | `hq:personal` | the list or counts you need |
| A project's colours, fonts, logo files | `hq:branding` (or the repo's brand folder) | hex colours, font names and file paths |
| A project's UI tokens (DESIGN.md) | `hq:designer` (or read DESIGN.md yourself) | the tokens |
| Facts about a code repo (commits, files, languages, tests) | yourself: read-only `git`/`ls`/`wc` in the repo | — |
| Numbers the user pasted or attached | yourself: save them to a CSV as given | — |

## 3. How to call a helper

Use the Agent tool with `subagent_type: "hq:<name>"` (or the `mcp__hq__invoke` tool with agent and task). The
helper works for you and replies to you, not to the user. Give it only what it needs, and ask for a file:

```
For a chart I'm making: total spending by category for October 2026, AUD, from your ledger.
Write it as CSV with header `category,amount` (numbers only, no currency symbols) to
<working folder>/data/october-by-category.csv. Reply with: the path, the source (which database/table),
the date range you used, the row count and the total, and anything you excluded and why.
```

Rules:
- One helper call per data set; run independent calls in parallel.
- Ask for **CSV with a header** (or JSON) at a path in your working folder, plus source, date range or "as of"
  time, row count and total. Those let you check it and write the source line.
- Never ask a helper to change anything; you only need reads. Never pass secrets.
- If the task came from Discord, post one status line while you wait:
  `<hq>/bin/hq-send --as image "📊 getting October numbers from finance…"`.

## 4. Check what came back (before drawing anything)
- The file exists, the header matches, the row count matches what the helper said.
- Recompute the total yourself (`img chart` doesn't change values; you check them). Units and currency are stated.
- Dates are the range that was asked for. Categories aren't duplicated ("Food" vs "food").
- If something is off, ask the helper once with the specific problem. If it's still off, say so; never fix
  numbers by guessing.

## 5. Build, look, finish, deliver
- Build with the tool from step 1. Put the source on the visual: `--source "Source: finance agent, ledger.db,
  Oct 2026"` or the URL marketing gave.
- Write the takeaway yourself only if the data shows it plainly (e.g. "Rent is 63% of spending" when that's the
  computed share). No causal claims the data can't support.
- Look at the PNG. Check every number on it against the CSV.
- Deliver as in `make-image/` step 5. Keep the CSV and the `.vl.json` / `.html` next to the PNG so it can be
  redone with new data in one command; note the command in `memory/projects/<ID>.md`.

## Worked example
"Make a graph of my spending this year" (from #image):
1. Chart. 2. Owner: finance. 3. Ask `hq:finance` for monthly totals Jan–Oct 2026 as `month,amount` CSV (in
   parallel: nothing else needed). 4. Check 10 rows, recompute the total. 5. Build it:
   `img chart quick bar --data …/monthly-2026.csv --x month --y amount --format '$,.0f' --title "Spending in 2026"
   --subtitle "Monthly total, AUD" --source "Source: finance agent, ledger.db" --preset ig-portrait --out …/spend-2026.png`.
   Look, then send it with `hq-send --caption`.
