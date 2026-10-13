---
name: workflows
description: Route any household request to the right `house` command, record it, and reply; also covers bills, the daily reminder and incoming bill notices.
---

# Workflows

`house` below means `python3 {{AGENT_DIR}}/tools/house.py` — always type it that way (one command per Bash call, so it
runs without an approval prompt). Output is JSON; read it and reply in plain words. Never paste raw JSON.

## 1. What is it?

| The user says / sends | Do | Command |
|---|---|---|
| A receipt photo, PDF or eReceipt email; "we bought…" | read `receipts/SKILL.md` | `house pantry import -` |
| "We have / I put X in the freezer, use by Friday" | add one item | `house pantry add "X" --where freezer --expires 17/10` |
| "What's going off?" / "what's in the fridge?" | list | `house pantry list --expiring 3` / `--where fridge` |
| "Finished the milk" / "threw out the spinach" | find the id, then | `house pantry use ID` / `house pantry toss ID` |
| "Need eggs" / "add oat milk, 2 cartons" | shopping | `house shop add eggs --by <person>` |
| "What do we need?" / "shopping list" | shopping | `house shop list` |
| "Got the eggs" | tick | `house shop got eggs` (a receipt import ticks matches automatically) |
| "I paid $42 for dinner" / "Sam paid the cleaner" | read `money/SKILL.md` | `house spend …` |
| "Who owes who?" / "我們扯平了嗎" | balances | `house balance` |
| "Paid Sam back $20" | settle | `house settle 20 --from <me> --to sam --group <g>` |
| "Scratch that" | undo the last record | `house undo` (or `--id N`) |
| A bill, bill email or "electricity is due on the 20th" | bills, below | `house bill add` / `house bill ingest` |
| "What should I cook?" / "what to buy on the way home?" / "we made X tonight" | read `cooking/SKILL.md` | `house cook suggest` / `cook need --add` / `dish cooked` |
| "What's due?" / "anything I should know?" | overview | `house status` |

Who is "I"? household.md in your memory says who usually writes. If the message shows the sender, use that.
Otherwise assume the usual sender and say so.

## 2. Bills

- New bill: `house bill add "Electricity" --provider Origin --amount 318.10 --due 2026-10-20 --every quarter
  --group house [--autopay] [--ref INV-123]`. If the amount isn't known yet, leave out `--amount`; the reminder
  shows "amount ?".
- Bill notice (an email, a PDF, a pasted text, or later a webhook): pull out name, provider, amount, due date,
  reference number and how often it comes, then pipe JSON into `house bill ingest -`. The same provider and due
  date (or the same `ref`) updates the existing bill instead of adding a second one.
- Paid: `house bill paid ID --by <person>`. This logs it as a group expense split equally, marks it paid, and schedules
  the next one using the same amount as an estimate. Use `--amount` if the final amount differed. Use `--no-log` if
  the cost isn't shared (e.g. an autopay from a joint account that's already split).
- Which group? household.md says which bills go where. If unsure, ask once and record the answer there.

## 3. The daily reminder

A launchd job (`dev.hq.house`) runs `house remind --send` every morning at 8:00. It sends bills due within 3 days
(and anything overdue) plus food expiring within 2 days to the house Telegram chat, and sends nothing when nothing
is due. Run `house remind` to preview it. The target is the household's Telegram group (`house config
telegram_chat`), posted by the bot granted to house as `telegram` in hq-auth. With no chat set, it goes to the
user's DM (hq-send).

## 4. Reply

Dates: quote the tool's `expires_day` / `due_day` labels ("Thu 15/10"); never work out a weekday yourself.
One or two lines: what you recorded (with ids for later), what you assumed, then the one question that's open. For
balances, quote the tool's `owes` lines exactly.
