---
name: cooking
description: What to cook tonight, what to buy on the way home, and the household's dish book (dishes cooked before, ratings, recipes saved by personal).
---

# Cooking

The dish book lives in `house.db` (`dishes` + `cooked`). You own it. Personal also adds dishes and cooked-dish logs
through the same tool (they show `added_by: personal`). Treat them like any other entry.

## "What should I cook?" / "dinner ideas" / "我今天煮什麼"
1. `house cook suggest --limit 6` (add `--tag quick` if they're tired or short on time). It ranks known dishes by how
   much is in stock, whether they use food that's about to go off, how long since the dish was last cooked, and
   rating. It also lists `expiring_soon` and `in_stock`.
2. Answer with **2–3 options**, best first. For each: the dish, why (e.g. "uses the chicken before Wed 14/10", "you
   haven't had it in 3 weeks, rated 5"), and what's missing. Prefer dishes with nothing or one cheap thing missing.
3. You may add **one new idea** built from `in_stock` + `expiring_soon` when nothing in the book fits well. Label it
   as new ("new idea, not in your book"), and keep it to ingredients they have plus staples.
4. Quote dates as the tool gives them. Never claim something is in stock unless `in_stock` lists it.

## "What should I buy on the way home?"
- For a chosen dish: `house cook need "<dish>" --add` puts the missing items on the shopping list. Reply with the
  full `shopping_list` as a short checklist, grouped (produce / meat / dairy / other).
- No dish chosen: run `house cook suggest`, pick the best option, say which one you assumed, then `cook need --add`.
- Optional ingredients are never added. Mention them as "if you see it".
- On Telegram or phone, keep the list scannable: one item per line, no explanations.

## "We cooked X" / "made the pasta tonight, 4/5"
- `house dish cooked "X" --by <person> [--rating 4] [--note "less salt next time"]`. If the dish is new, the tool adds it.
  If the result has `todo` (no ingredients), ask once for the main ingredients or infer them from the dish name
  ("Tomato egg stir-fry" → tomatoes, eggs, spring onion), then run `house dish edit ID --ingredients "…"`.
- The result lists `pantry_maybe_used`. Mark the obvious ones used (`house pantry use ID`), e.g. the chicken in a
  chicken dish. Leave bulk items (a dozen eggs, a bag of rice) unless they say they're finished.

## Saving a dish or recipe
`house dish add "Name" --ingredients "a, b, c" [--optional "x"] [--tags quick,taiwanese] [--minutes 20]
[--url https://…] [--note "…"] [--by <person>]`. Write ingredients the way they'd appear on a receipt ("chicken thigh",
not "500g boneless chicken thigh, diced"). That's what matching against the pantry relies on.
- Recipes from a link (reel, blog): personal owns the link library. If the link isn't saved yet, ask personal
  (`hq:personal`) to save it, then put its URL on the dish.
- Things you always have, like salt, oil and soy sauce, are staples and never count as missing. Show them with
  `house config staples`; to change them, `house config staples "salt, pepper, oil, soy sauce, …"`.

## Browsing
`house dish list --tried` (cooked before), `--to-try`, `--tag T`, `--search garlic`; `house dish show NAME` gives
the history and ratings.
