---
name: Kith app
description: Your crew of agents on your phone and Mac. Stock Apple underneath, a thin Kith layer on top.
colors:
  bg: "#FFFFFF"
  ink: "#14161B"
  muted: "#6B7280"
  muted-on-sky: "#4B5160"
  line: "#ECEDF2"
  panel: "#F6F6FA"
  accent: "#6A45F2"
  accent-dark: "#B49CFF"
  attention: "#936000"
  attention-bg: "#FFF1DC"
  positive: "#178357"
  negative: "#C93450"
  night: "#14161B"
typography:
  agent-name:
    fontFamily: "Nunito, SF Pro Rounded, sans-serif"
    fontSize: "16px"
    fontWeight: 800
    lineHeight: 1.2
  top-bar:
    fontFamily: "Inter, SF Pro Text, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "Inter, SF Pro Text, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  secondary:
    fontFamily: "Inter, SF Pro Text, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "Inter, SF Pro Text, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.06em"
  code:
    fontFamily: "JetBrains Mono, SF Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  chip: "999px"
  row-tool: "10px"
  card: "18px"
  sheet: "36px"
  glass-pill: "28px"
spacing:
  gutter: "16px"
  row-v: "9px"
  stack: "10px"
components:
  bot-avatar:
    size: "48px"
  bot-avatar-small:
    size: "24px"
  chat-box:
    backgroundColor: "rgba(255,255,255,0.58)"
    textColor: "{colors.ink}"
    rounded: "{rounded.glass-pill}"
    height: "54px"
  top-button:
    backgroundColor: "rgba(255,255,255,0.58)"
    rounded: "{rounded.chip}"
    size: "42px"
  decision-card:
    rounded: "{rounded.card}"
    padding: "12px"
  thread-folded:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  thread-open:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  tool-row:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.row-tool}"
    height: "44px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "12px"
    padding: "9px 13px"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "12px"
    padding: "9px 13px"
  you-tag:
    backgroundColor: "{colors.attention-bg}"
    textColor: "{colors.attention}"
    rounded: "{rounded.chip}"
---

> Source: `~/Workspace/design/kith/app-style/DESIGN.md` (the designer's folder), copied 2026-10-23. The designer owns this spec: do not edit it here, changes come from the designer and are re-copied.
> Only change from the source: image names point at `docs/design/mocks/...` (`search.png` ships as `search.jpg`, downscaled to keep the repo light).
> Boards named below but not copied (`home-v4.png`, `threads.png`, `home-v3.png`, `context.png`) are superseded by the copied set. The `sky/*.png` assets stay in the designer folder; the tokens PR adds them to the app assets.
> The text below is verbatim, including its mentions of the previous design by its old name.
> Feature mapping and build order: `feature-inventory.md`.

# Design System: Kith app

status: draft v1, 2026-10-23, from Kai's decisions in this session (decisions.md, designer lines of 2026-10-23).
Boards: `home-v4.png` (home), `threads.png` (agent chat), `home-v3.png` (routing, call, colour sheet), `docs/design/mocks/system.png` (components).
Brand source: branding's `brand/` (BRAND.md, brand.tokens.json, living-bots/LAYERS.md). Brand wins where they disagree.

## Overview
Kith is your crew of agents, and the app is where you talk to them. It is **stock iOS 26 underneath** (lists, menus,
sheets, swipe actions, SF Symbols, Liquid Glass) with a **thin Kith layer** on top: the living crew, a morning sky,
a handful of own components, Nunito for agent names. It keeps what works in Codync and adds rather than reacts.

Four ideas carry it:
1. **The bottom is for talking.** Only the chat box lives there; + inside it adds files and images.
2. **One crew, not machines.** Agents run on whichever Mac they live on. Machines appear only when they matter.
3. **Every message starts something new.** Each message is a new session; old ones fold into thread rows.
4. **The bots are the colour.** The page is white with a real sky at the top; colour comes from the crew.

## Colors
- Ground: white. On home, a real morning sky (clouds with warm peach edges, `sky/sky-3.png`) fills the top and
  fades to pure white by mid-screen; it stays still while the list scrolls over it. Agent chats keep a short strip of the same sky behind their top bar. Other screens are plain white.
- Ink `#14161B` for text and primary buttons. Muted `#6B7280` (on the sky: `#4B5160`).
- Accent violet `#6A45F2` sparingly: selected states, links. "Needs you" is a small ink count badge (18 pt, white Inter 11 bold, tabular figures: how many questions wait on you) + the question in ink (no amber pill, no `you` tag). The Board tab carries the total (16 pt badge). A thread chip keeps a plain dot + "your turn". Green and red
  only for results (tests passed, errors), always with a word.
- Bot colours: each bot has a default pair; the user picks from **presets** (branding's palette), as **gradient or
  plain**. No free colour wheel. The bot body is recoloured through its tint layer; eyes never change. A tinted
  surface (decision card) uses the bot's pair at low strength.
- Dark mode: night `#14161B` ground; the home sky and the chat strip become the same clouds at night (`sky/night-1.png` or `night-2.png` with faint stars; chat strip `sky/header-night.png`, day `sky/header-day.png`). Bubbles #2C303A (you) / #1E2129 (agent), glass dark. Board: `docs/design/mocks/dark.png`.

## Typography
- Agent names: Nunito 800, 16. The only place Nunito appears in the app UI.
- Top bar text: Inter 600, 16. **No large titles, no display titles anywhere.**
- Body Inter 15/1.45, secondary 13, labels 11 bold tracked, code and numbers JetBrains Mono 12.
- All text follows Dynamic Type; Inter can fall back to SF Pro.

## Layout
- **Home / Board**: top = your profile picture (left; until a photo is set, a piece of sky: a cloud from the Kith sky over a dawn, clear or dusk tone, seeded per account, no letter), Crew | Board switch (centre), new-chat (right). Middle = crew list.
  Bottom = the chat box (+ for files and images, field, mic) with a round call button to its right, floating glass; while you type the call button slides away and the box takes the full width (back when the text is cleared). No tab bar, no search bar, no title, no machine name.
- **Crew** list: one row per **room**, sorted needs-you → working → recent. A room is any place people talk: your 1:1
  with an agent, a team room (teammates + one default agent), a group (several agents + people, @names route). Your 1:1
  with coder and the room you share with Mia are two rows ("coder with Mia"). Agent row = bot (48, no tile), Nunito name,
  time or state, one sentence of status. Team row = the agent's face with the teammate's sky patch on its lower-left
  (working dots keep lower-right). Group row = two bots on the diagonal + one sky patch, name in Inter 600 so it never
  reads as an agent. A teammate sees an agent's row only when they're a member of it. Long-press: pin, colour, sleep,
  share. Board: `docs/design/mocks/crewteams.png` (A).
- **Board**: projects, decisions, where-we-left-off cards, and Waits as a section. Swipe sideways from Crew.
- **Agent chat**: the home sky shows behind the top bar and fades out by ~170 pt (day: sky-3; night: the night sky). Top = back, bot + name, phone + ••• pair. Feed of threads. Bottom = the chat box ("Tell coder…").
- Gutter 16, row padding 9 vertical, thumb-zone actions in the bottom half, 44 pt minimum targets.

## Elevation & Depth
- Liquid Glass only for floating controls (top buttons, chat box, menus, sheets): translucent white, blur, a thin
  white edge. Content never sits in glass.
- Bots carry a soft drop shadow (0 2 4, 12% ink) so they sit on white or sky without a tile.
- Menus open with a light blur of the content behind.

## Shapes
Pills for glass controls and chips; 18 pt cards; 10 pt tool rows; 36 pt sheets. Bots have no frame, tile or mask.

## Components
### Bot avatar
The crew bot itself, 48 (list), 30 (top bar), 24 (in a thread), 84 (colour sheet). No background tile. States from
the living-bots motion spec: working (hop dots badge), needs you (looks up), idle, asleep (faded, eyes shut).
### Chat box (home)
Search, router and composer in one. Placeholder "Find or ask…". Empty: mic. Letters: the list above turns into results
in place (one ranked list while typing; scroll drops the keyboard and groups People, Groups, Agents, Threads), ending
with "Search the crew's memory" (slow, Mac-side, never per keystroke) and "Ask the crew". Rows open, the arrow sends:
grey while a match leads, ink once the text will be sent; Return reads "Open" or "Send" to match. Opening a thread
lands on the matching message; Back returns to the results. Same on Board. Board: `docs/design/mocks/search.jpg` (A). A sentence: shows "Goes to: coder ·
new session" with two alternatives before sending; `@name` skips routing; `/` opens commands. Send always starts a
**new session**. + at its left attaches files or images (Photos, Camera, Files). The call button beside
the box (home and Board) calls the agent **directly**: the agent the box would route to, or pick one. In an agent chat the phone stays at the top right.
### Top controls
- Profile picture: same default for teammates in threads (agents have faces, people have sky). Menu with account, Computers (each Mac and its health), Settings.
- Crew | Board: segmented glass switch.
- New chat (square.and.pencil, as in Messages): native menu: New bot (template or crew), Invite a person, New group chat.
### Thread (agent chat)
Codync's original thread, kept: your message is a normal bubble (right), and the thread hangs under it as a small
chip: bot avatar, "N replies" (ink; "1 new" as a small pill in the agent's colour pair), time, a down-arrow; "1 new" when replies arrived while folded. The place it ran
in sits beside the chip in small grey (folder · project). Down-arrow opens the replies in place (agent bubbles left,
tool rows, decision cards) with a thin line in the agent's colour pair down the left (open chip tinted the same; never the violet accent); the chip turns up-arrow to fold. Tapping the chip
text opens the thread full screen to continue it. The newest thread is open; idle ones fold, as tasks do today.
Every message from the box starts a new thread. Board: `docs/design/mocks/threads2.png`.
### Place chip
Folder icon + project · subfolder: where a thread runs, picked by the router so the agent loads the right context.
On the route card before sending (with a one-line reason and alternatives), beside each thread chip, and in the open
thread. Tap → "Where coder works" sheet: Suggested (with reasons), Projects, Choose a folder…, Mac. Changing it
starts the thread fresh in the new place. Unsure router = decision card with two places. Board: `docs/design/mocks/place.png`.
### Correct
How to tell an agent it got something wrong so it sticks (a reply fixes this thread only). Main entry: long-press an
agent reply → "Correct this", prefilled. Also a small grey "Correct" beside the Call capsule in the agent sheet and
"Correct…" in the chat's ••• menu. One field, "What should coder do differently?"; Kith answers with a proposed-fix
card that names where it goes: a memory note (before → after), a learned skill the agent writes itself, or a move to
another project (restarts there). Apply / Edit / Cancel. Every correction lands in Memory history as "You · corrected"
with Undo. Project decisions are append-only: a wrong one gets a correcting line. Builder is for new bots, not fixes.
Board: `docs/design/mocks/context3.png` (B).
### Decision card
An agent's question as buttons, tinted with that agent's colours; permission prompts use the same card (Allow /
Deny / Always). Free text still works in the chat box. Answerable without opening the thread.
### Tool row
One line per tool call, 44 pt: verb + object, result on the right in mono. Tap: stock sheet with command and output.
No terminal view anywhere.
### Handoff card
"Where we left off" for a sleeping session: what was done, next step, files/PRs. Only real fields; nothing invented.
### Status chips
Word + colour, never colour alone: Live, Catching up, Needs you, Mac unreachable, /urgent. Machine trouble shows as
one chip ("Mac mini busy, 1 queued"), one tap from Computers.
### Colour sheet
Preview of the bot, Gradient | Plain switch, preset swatches, Reset to default.
### Icons
SF Symbols in the app (phone.fill, square.and.pencil, plus, mic.fill, chevron.down/up, ellipsis, gearshape). Never emoji.

## Do's and Don'ts
### Do:
- Keep the bottom to the chat box (+ attach, field, mic).
- Start a new session for every message; fold old ones.
- Let the crew bring the colour; keep chrome white and glass.
- Show machines only when something needs attention or the user asks.
- Reuse stock iOS controls before drawing anything custom; a new style becomes a component first.
### Don't:
- Large or display titles, top search bars, bottom tab bars, a call button that stays visible while typing.
- Tiles or frames behind bots; recolouring the eyes or the cube logo.
- Grain, strong gradients, or the logo gradient as a page background.
- Floating bots or decorative motion on home.
- Emoji or Unicode glyphs as icons.
- Framing Kith against Codync: keep what works.

## Open
- Thread context (what an agent loaded and wrote for a thread): context.png chip and context2.png agent-sheet card both rejected by Kai (2026-10-23); new direction needed. Places are named by project (briefcase icon), folder only outside a project.
- Any room member may join a thread someone else started (Kai, 2026-10-23); the backend still refuses non-owners.
- Branding: confirm the preset palette for user colours (gradient + plain versions of the 15 pairs).
- Board layout in this style (only sketched in phone-app v1).
