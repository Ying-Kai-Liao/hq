---
name: chart
description: Data charts as finished images in the house style — bar, horizontal bar, line, area, donut, scatter, or any Vega-Lite chart — with title, takeaway and source, from a CSV or JSON file.
---

# Make a chart

Command: `<pkg>/tools/img chart …` (Vega-Lite rendered locally, then laid out as a card).
Getting the data from another agent: `workflows/SKILL.md`. Choosing the chart: `references/chart-selection-patterns.md`
(and `visualization-strategy.md` for a critique).

## Pick the chart
| Question the chart answers | Kind |
|---|---|
| How do categories compare? (≤ 12, long labels) | `hbar` with `--sort desc` |
| How do a few categories or periods compare? | `bar` |
| How did it change over time? | `line` (one or a few series, `--color COL` for series) or `area` for a total |
| What share is each part? (≤ 6 parts, adds up to a whole) | `donut`; more parts → `hbar` |
| Are two measures related? | `scatter` |
| Anything else (stacked, small multiples, annotations, dual encodings) | write a Vega-Lite spec → `img chart spec` |

## Commands
```
img chart quick hbar --data spend.csv --x category --y amount --sort desc --format '$,.0f' \
  --title "Where October's money went" --subtitle "Spending by category, AUD" \
  --takeaway "Rent is 63% of spending" --source "Source: finance agent, ledger.db" \
  --preset ig-portrait --out ~/Workspace/design/<id>/images/oct-spend.png
img chart quick line --data monthly.csv --x month --y amount --color account --preset og --out …
img chart spec my.vl.json --data rows.csv --title "…" --preset slide --out …     # data replaces spec.data
img chart quick bar … --svg-only --out chart.svg                                 # just the chart, for a page
```
- `--format` is a d3 format: `$,.0f` dollars, `,.0f` thousands, `.0%` percent (data as 0–1), `.1f`.
- `--time` when x is a real date column (`2026-03-01`); plain labels ("Mar") keep the CSV order.
- `--theme FILE` for a project's colours (see `infographic/` for the theme file). Sizes: `img presets`.
- Outputs next to each other: `name.png` (send this), `name.svg`, `name.vl.json` (the full spec, to redo or
  tweak), `name.html`, `name.content.json`.

## Rules
- Plot the data exactly as received. Never invent, round away or drop values; aggregate only with a stated rule
  (e.g. "top 8, rest as Other") and say so in the subtitle.
- Every chart with real data gets a `--source`. Units go in the subtitle or the format.
- The takeaway states what the data plainly shows, computed by you from the file, never a guess about why.
- Look at the PNG: labels readable, nothing clipped, numbers match the CSV, colours distinguishable. Then deliver.
