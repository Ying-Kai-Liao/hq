---
name: receipts
description: Turn a grocery receipt (Woolworths photo, PDF or eReceipt email) or a spoken list into pantry items with expiry dates, and optionally the shared expense.
---

# Receipts → pantry

1. **Read it.** Open the attached file with Read (photos and PDFs both work). Discord attachments arrive as paths
   in the task. Woolworths receipts list one line per product, abbreviated (e.g. `WW F/C MILK 2L`, `CHKN THGH
   FIL`). Write each one as a plain name a person would say ("Woolworths full cream milk 2L"). Note the store, the
   date and the total.
2. **Keep only food and drink that goes off,** plus pantry staples worth tracking (rice, pasta, oil). Skip bags,
   cleaning products and toiletries; mention them in one line if the user might care.
3. **Expiry per item:**
   - A date printed on the receipt or told by the user is the real one: `"expires": "2026-10-20"`.
   - Otherwise estimate it from `shelf-life.md`, counted from the receipt date, and set `"estimated": true`.
   - Long-life items (tins, dry pasta, rice): leave `expires` out.
   - Choose `where`: fridge, freezer or pantry, the way it's normally stored in Sydney.
4. **Import** in one call:
   ```bash
   house pantry import - <<'EOF'
   {"source": "receipt: Woolworths Town Hall 2026-10-13 ($84.20)",
    "items": [{"name": "Full cream milk 2L", "where": "fridge", "expires": "+7d", "estimated": true, "qty": 1},
              {"name": "Chicken thigh fillets 1kg", "where": "fridge", "expires": "2026-10-15"}]}
   EOF
   ```
   It ticks matching items on the shopping list by itself.
5. **The money** (optional): if the receipt is for shared groceries, ask which group (household.md has the usual
   question) unless it's obvious, then `house spend TOTAL --by <payer> --group <g> --note "Woolworths 13/10"`. See
   `money/SKILL.md`.
6. **Reply:** "Added 12 items (4 with estimated dates). Use first: chicken (Wed). Ticked off: milk, eggs." List the
   estimates only if the user asks.

Said aloud instead of a receipt ("we have half a lasagne, eat by Thursday"): `house pantry add "lasagne (half)"
--where fridge --expires thursday` (a weekday means the next one; today counts).

When a dated item is used or binned, mark it (`use` / `toss`) so the reminder stays honest.
