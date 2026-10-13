---
name: screen-demo
description: Turn a screen recording into a product demo, walkthrough or launch video. Three modes the user approved (2026-10-13), edited footage, frame by frame (UI rebuilt in HTML) and hybrid, plus auto-zoom camera, brand cards, captions, Kokoro voiceover and a lab page for picking takes.
---

# screen-demo

Recording in, short branded video out. Built and tested on flow's demo recordings (`examples/flow/`, renders in
`~/Workspace/design/flow/video/renders/`). Uses HyperFrames (`../../hyperframes/SKILL.md`) for every render.

## Pick a mode (the user keeps all three)

| Mode | Use for | Cost |
|---|---|---|
| **Footage**: the real recording, framed, with a camera and type over it | Walkthroughs, internal demos, anything that must prove the product works | ~10 min once the regions are mapped |
| **Hybrid**: footage, plus one or two key UI moments rebuilt in HTML and lifted above dimmed footage | Default for product demos: proof plus readable key moments | + ~15 min per rebuilt component |
| **Frame by frame**: the UI rebuilt in HTML and animated (counters, key presses, toasts) | Launch stings and hero beats, where polish beats proof | ~40 min per screen; cheaper if the product's real web components can be mounted with fake data |

If the brief doesn't say, propose hybrid and say why. For a launch, show more than one mode on the lab page.

## Pipeline

1. **Survey.** `scripts/prep.sh survey <rec> <dir>/source/` gives a contact sheet, screen-change times (candidate
   beats), silences and the size. Look at the sheet and write a beat map: what happens when, and the dead time to cut.
   Recordings from Cap (cap.so) also have cursor.json with clicks, which are better zoom targets than scene changes.
2. **Cut proxies.** `scripts/prep.sh cut <rec> <start> <dur> <dir>/clips/<seg>.mp4` per beat (CFR 30 fps, GOP 10).
3. **Map regions.** In `<dir>/project.json` (shape in `scripts/build.py` docstring, example `examples/flow/project.json`)
   name the rects you'll zoom to, in source px. Measure them on a full-size frame, not the sheet.
4. **Write specs** (one per take, 5-10 s while testing). Keys:
   - `size` [w,h] (default 1920×1080; 1080×1920 for vertical: re-aim at the action, never centre-crop), `theme` paper|ink,
     `duration`, `raw` (letterboxed control), `intro` (window rise, default true), `win_h` (window height fraction)
   - `segments` [{clip, start, dur, media_start, xfade}]
   - `camera` [{at, to: "wide"|region, fill, cx, cy, dur, ease}]: moves time themselves (0.35 s + 1.35 ms/px,
     0.6-2.4 s); give `dur` ~0.25 to land a cut on a new segment. Zoom is capped at `max_mag` per source px.
   - `callouts` [{rect, at, until, chip, pad}], `captions` [{at, until, text}] (bottom), `heads` [{at, until, text}] (big,
     top-left, on an ink panel). Wrap the one accent word in `<span class='g'>`.
   - `cards` [{kind: mark|lockup, at, until, tag, fade_out, accent_last}]: mark wipes up then its last path (the accent)
     slides in; lockup fades in with the tagline.
   - `overlays` [{html, tl}] (hybrid): an HTML fragment with its own `<style>` and a file of GSAP lines on `tl`.
     Example: `examples/flow/q43.html` + `q43.js` (dim the footage, lift the question card, press `y`, slide in the
     toast). Move the camera off any real element you rebuilt, or it shows twice.
5. **Build and render.** `python3 scripts/build.py <dir>/project.json [comp...]` writes `<dir>/comps/<comp>/index.html`;
   then `npx hyperframes render <dir>/comps/<comp> -o <dir>/renders/<comp>.mp4` (10-25 s each).
6. **Check frames** at every beat before showing anything (ffmpeg `-ss t -frames:v 1`).
7. **Voiceover** (when asked): `<tts-py> scripts/voice.py "<script>" <dir>/voice/vo`. Kokoro `af_heart` is the user's
   English pick; it writes word timings and fails (exit 2) when Whisper hears something other than the script.
   Time captions from `words.json`. `<tts-py>` is a venv with `mlx-audio mlx-whisper`; one exists at
   `~/Workspace/design/flow/video/voices/.venv`. No Chinese voice is approved yet (see references).
8. **Review on a lab page.** Publish a private artifact with the `db` capability: each take as a looping video with
   what/how notes and Keep / Maybe / Drop plus a note, saved to `picks/<id>`. Template: `examples/flow/lab-page.html`
   (edit the `TAKES` arrays; media goes beside it in `media/`, web copies at crf 22). Read picks back with ArtifactData.

## Frame by frame mode
Write the composition by hand; `examples/flow/synthetic.html` is the reference: the flow pane rebuilt as HTML
(JetBrains Mono, sized for 1080p, never smaller than ~26 px), rows stagger in, numbers count via a proxy-object tween
with `onUpdate`, a keycap press flips an option to the accent colour, a toast slides in. Copy the real UI's text and
layout from full-size frames, not memory.

## Rules learned in the lab
- Determinism: no `Math.random`, `Date.now`, `repeat:-1` or async timeline building. Any web effect must be driven by
  the frame/time HyperFrames gives it (shader libraries OK; wall-clock animation libraries not).
- Timed elements need `class="clip"`; a full-frame overlay starts at `opacity:0`; a `fromTo` placed later on the
  timeline needs `immediateRender:false` or it hides the element from frame 0.
- Zoom must fill the frame with the target (T3's first cut, with `max_mag` 1.25, left window edges in shot; 1.7 is right
  for retina). Text over terminal footage needs a solid panel.
- Local ffmpeg has no drawtext/subtitles: all type is rendered in HyperFrames.
- Brand: the accent colour only on the meaningful thing (for flow, decisions); no gradients, glows or neon; captions
  ≤ 6 words a line. Each project keeps its own `DESIGN.md` (`examples/flow/DESIGN.md`).

More: `references/notes.md` (what the user picked and why, voices, open options).
