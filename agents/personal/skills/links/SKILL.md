---
name: links
description: Save, enrich, recall and map the user's links and places with the personal link library (links.py). Use for "save this", "what did I save about X", "where should I go", "make me a map".
---

# Links and places

Tool: `python3 <pkg>/tools/links.py <command>` (written `links` below), where `<pkg>` is your package folder
(`{{AGENT_DIR}}` in your instructions) and `<home>` your home folder (memory and data). Output is JSON.
Data: `<home>/data/links.db` (not in git), page snapshots in `data/snapshots/`, maps in `data/maps/`.

The tool does the fetching and storing. You do the judgement: what it is, why it matters to the user, how it
connects to what they already saved.

## Save (every time the user gives you links)
1. `links add URL... [--note "what the user said about it"] [--tags a,b]`. It fetches the page, pulls title,
   description, author, date, JSON-LD (places, events, products, articles), Maps coordinates, the readable text and
   a snapshot; places without coordinates are geocoded. Duplicates are merged, not re-added.
2. For each new link, `links show ID` and read it (`--content` for the full text when the preview isn't enough).
3. `links annotate ID --summary "..." --why "..." --tags a,b [--kind K] [--set field=value]`:
   - **summary**: 1–3 sentences on what it actually is, from the content, not the page's marketing line.
   - **why**: why the user saved it or when it will be useful (use their note; infer if obvious, else leave out).
   - **tags**: 2–5 lowercase, reuse existing ones (`links stats` shows top tags) before inventing new ones.
   - **kind**: article, video, place, event, product, repo, tool, recipe, post, paper, other.
   - Places: make sure `name`, `city`, `area` and `lat`/`lon` are right (`--set city=London --set area=Soho`).
     Events: `starts_at`, `venue`, `city`. Fix anything the page got wrong; fields you set are pinned and
     re-enriching won't overwrite them.
   - The user's own site and accounts (listed in `shared/user.md`): tag `mine`, summarise what they published, skip the why.
4. **When plain fetching isn't enough**, get the content yourself; don't hand it back to the user. Triggers: a
   `fetch_error`, a login wall (Instagram, X, LinkedIn, Xiaohongshu), or almost no content (`content_chars`
   under ~300 on a page that clearly has more).
   - jev-browser (MCP): `browser_open(url)`, then `browser_read("what is this, and every detail worth keeping:
     names, address, dates, prices, hours, who made it")`. On `needs_login`, run it headed with the profile in
     `JEV_BROWSER_PROFILE` and finish the login flow if the user has saved a session there.
   - Otherwise any tool you have: WebFetch, web search on the title or handle, the page's oEmbed or API.
   - Save what you got: `links text ID --via <tool>` with the text on stdin, then annotate as usual.
   - Read only: never like, follow, buy, post or send. Ask the user only when every route is exhausted.
5. Report briefly: one line per link (title, kind, the why). Don't paste the JSON.

## Reels and videos (Instagram, Facebook, TikTok, YouTube)
- `links add` already gets the caption, author, date, likes and thumbnail (Meta sites are fetched as a link-preview
  crawler, which they answer in full).
- The caption often isn't the point: the place name, recipe or tip is *said* in the video. Run
  `links transcribe ID` for any reel or short video (it skips videos over 20 min unless `--max-min N`). It
  downloads the audio with yt-dlp, retrying with the agents' own logged-in Chrome profile ("Agent") when needed, transcribes locally with
  mlx-whisper (any language), and adds the transcript to the content so search finds it.
- Read the transcript before annotating. Music-only audio is noise: when the result says `likely_no_speech`, ignore the transcript (Whisper makes up words over music, often in a random language) and work from the caption. Pull names, addresses, dishes,
  prices out of it into the place/event fields, and say in `summary` what the video actually shows.
- If the thumbnail would help (a place's storefront, a dish), look at the `image` URL.

## One post, several places
Reels and articles often list several places ("coffee at X, ride Y, sunset at Z"). Save **each place as its own
link** so trip planning can use it: `links add "https://www.google.com/maps/search/?api=1&query=<Name>+<Town>"
--note "from link <ID>: <what the post says about it>" --tags <town>,<theme>`, then look it up (below) and
annotate its `why` from the post.

## Look places up on Google Maps (jev-browser)
OpenStreetMap geocoding is only a fallback: it misses many businesses and sometimes matches the wrong one. For
every place, confirm it on Google Maps with jev-browser (a few seconds each):
1. `browser_open("https://www.google.com/maps/search/<Name>+<Town>")`.
2. `browser_snapshot(max_chars: 3000)`. When it lands on a single place, the `url:` line is a `/maps/place/...`
   URL with the exact coordinates, and the visible text has the name, rating, category, address, hours, website
   and phone. If it shows a list, pick the right result (`browser_act`) or narrow the query.
3. Save it: `links annotate ID --set maps_url="<that /maps/place/ URL>" --set address=".." --set
   rating="4.8" --set hours="opens 6 am" --set website=".." --set phone=".." --set cuisine="coffee shop"`.
   `maps_url` fills name and lat/lon from the URL by itself.
Do several places in one browser session, and close it at the end. Never guess coordinates.

## Phone inbox
`links inbox` ingests `~/Library/Mobile Documents/com~apple~CloudDocs/hq/inbox.txt` (iCloud Drive; one URL per
line, any text on the line is the note), then clears the ingested lines. Lines without a URL stay for you to read.
Run it at the start of any links task, then annotate what came in (`links list --todo`).

## Recall
- `links search "query" [--kind K] [--tag T] [--city C]`: full text over title, summary, why, notes, tags, place
  fields and page content. Plain words are prefix-matched and ANDed.
- `links list [--kind K] [--tag T] [--status S] [--todo]`, `links show ID`, `links export` (Markdown).
- Answer with the links themselves plus your why; group related ones.
- Status: `saved` (default), `read`, `done`, `been` (a place they went), `archived`.
  `links annotate ID --status been` when the user says they went; ask how it was and put it in `note`.

## Where should I go (trip advice)
1. `links places [--city C] [--tag T] [--near LAT,LON --km N]` lists saved places (Hermes's old places list
   has been imported; `--hermes` reads it again live, read-only).
2. Pick 3–6 for the occasion (day, weather if known, who they're with, what they said they want). Prefer places
   near each other, mix kinds (a walk, a meal, a coffee), and say **why each one, in one line**, using its why/note.
3. Check the weather for the day: `links weather --place ID --date YYYY-MM-DD` (or `--at=LAT,LON`). Rain →
   indoor picks and covered walks; heat → morning outdoors; use `sunset` for lookouts. Check each pick's `hours`
   against the day (re-check on Google Maps if unsure) and never send them somewhere closed.
4. **Curate the day and render it as a plan card**: write a plan JSON and run `links plan FILE.json --open`.
   It makes a light HTML page (works on a phone: live map, tap a stop to fly to it) and a 1080-wide PNG of the
   same card. Always end trip advice with it: look at the PNG yourself (Read it) to check it, then send both to
   his phone: `hq-send --caption "<title>: <one line>" <png> <html>` (hq-send is in the hq `bin/` folder named in
   your protocol). Give the paths in your reply too.
   ```json
   {"title": "Blue Mountains by train", "date": "2026-10-17",
    "summary": "One or two sentences: the idea of the day and how the weather shaped it.",
    "info": [{"icon": "🚆", "value": "~2 h", "label": "Central → Katoomba"}],
    "stops": [{"id": 12, "time": "9:00", "icon": "☕", "what": "Flat white + pastry · 30 min",
               "why": "Why this stop, for him, today.", "tip": "Optional practical tip.",
               "fact": "Optional tourist fact about the place.", "move": "Optional: how to get to the next stop"}],
    "notes": ["🧥 Bring a layer: ..."]}
   ```
   - `id` pulls name and coordinates from the library; the tool fills in walking times, total walking, sunset and
     the weather chip. Up to 4 info tiles (you give 1–2, it adds walking and sunset).
   - **Every fact must be checked**: weather from `links weather`, hours and ratings from Google Maps, transit,
     prices and tourist facts from a source you looked up (web search, the official site). No invented bus numbers,
     prices or records. If you couldn't check it, leave it out.
   - Order the day around the weather and opening hours, not the order things were saved.
   - Plans are saved in `data/plans/`.
   For a quick "everything I saved in X" map, `links map --city X --png` is still there.
5. Places missing coordinates are listed as `without_coordinates`: fix them with `annotate --set lat= --set lon=`
   or `links enrich ID --force` after setting an address.

## Browse
`links page --open` writes `data/library.html`: everything saved, with search, kind and tag filters, and a map
view. Regenerate it after saving or annotating, and give the user the path when they want to browse.

## Notion mirror
Every command that changes the library also pushes the new or changed links to the user's Notion "Links"
database (one-way; local is the source of truth, edits in Notion don't come back). Archived links are archived
there too. If a command warns that the sync failed, run `links notion` to retry; `links notion --all` re-pushes
everything. First-time setup: `links notion --parent <Notion page URL>` (the page must be shared with the
integration; the key comes from personal's `notion` grant via `hq-auth`, see `hq-auth ls`).

## Maintenance
`links stats` shows counts, untagged links, failed fetches and places without coordinates. `links enrich
--pending` retries failed and never-fetched links.
