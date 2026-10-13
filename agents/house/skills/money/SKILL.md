---
name: money
description: Record shared spending, split it the right way between the household's money groups, settle up, and answer who owes whom.
---

# Shared money

`house people` shows the people (by key) and the money groups. Which costs go to which group, and the question to
ask when it's unclear, are in your memory's `household.md`. If you can't tell which group, ask once. Never guess on
a large amount. The examples below use made-up people `alex`, `sam` and `jo`, and groups `pair` and `flat`.

## Commands
- Equal split: `house spend 84.20 --by alex --group pair --note "Woolworths 13/10"`
- Only some members of the group: `--among alex,jo`
- Uneven, by weight: `--split alex=2,sam=1` (alex bears two thirds)
- Uneven, by exact amount: `--split alex:30,sam:12.50` (must add up to the total; the tool checks)
- Someone pays someone back: `house settle 20 --from sam --to alex --group pair`
- Balances: `house balance` (all groups) or `--group pair`. Quote the `owes` lines.
- Recent records: `house history --group flat --limit 10`
- Mistake: `house undo` voids the latest record (or `--id N`). It is kept as history, never deleted. Undoing a
  bill payment reopens the bill.
- A past date: `--date 2026-10-10`.

## Rules
- The payer must be in the group. "I paid for jo's share of the power" is still `--group flat`, paid by the speaker.
- Don't compute balances or totals yourself; run the tool.
- Each group is its own pot: a debt in one group doesn't cancel one in another. Say so if someone asks for one
  total.
- Systems house replaced (household.md lists them) are not written to. If the user asks to bring their history
  over, that is a one-off import: ask which entries and into which group.
