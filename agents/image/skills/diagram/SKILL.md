---
name: diagram
description: Diagrams as images — flowcharts, processes, systems, sequences, states, mind maps — from Mermaid in the house style; archify for showcase architecture diagrams.
---

# Make a diagram

## Mermaid (default)
Write `name.mmd` in the working folder, then `img diagram name.mmd name.png [WIDTH]` (PNG at 3x + SVG).
- Types: `flowchart LR|TD`, `sequenceDiagram`, `stateDiagram-v2`, `mindmap`, `timeline`, `gantt`, `erDiagram`,
  `classDiagram`, `journey`, `quadrantChart`.
- Line breaks in a label: `<br/>` (not `\n`). Keep labels to a few words; ≤ 12 nodes per diagram, split otherwise.
- Shapes: `([rounded])` for start/end, `{decision}`, `[(database)]`, `[[subroutine]]`; group with `subgraph`.
- To colour the important path: `classDef key fill:#f3e3dc,stroke:#c0694a;` then `class A,B key;`.
- If it fails, the error names the line: fix the syntax (quotes around labels with brackets or punctuation).

## archify (architecture showcase)
For a polished system or cloud architecture diagram, use archify if it's installed on this Mac:
`~/.agents/skills/archify/SKILL.md` (MIT, by tt-a1i). Read that SKILL.md and follow its fast path; it writes an
HTML diagram. Turn that into an image with `img ig shot --html OUT.html --size 1600x1000 --out OUT.png`.
If it isn't installed (another device), use Mermaid.

## Rules
- Diagrams of real systems come from real evidence: read the repo or ask `hq:devops`; don't invent components.
- Look at the PNG: no overlapping labels, arrows go where they should, readable at the size it will be shown.
