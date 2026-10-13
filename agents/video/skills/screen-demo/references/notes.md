# screen-demo: lab notes (flow, 2026-10-13)

## Takes the user rated
- Keep: framed on paper (T2), auto-zoom (T3), launch sting (T5), vertical 9:16 (T6); footage, frame by frame and
  hybrid versions of the launch sting (all three kept).
- Maybe: callouts + captions (T4). Drop: the raw recording (T1).
- Defaults that follow: paper frame for walkthroughs, ink stage for launches, auto-zoom on, a mark → beats → lockup
  sting for launches, a vertical cut alongside.

## Voices (same script read by each)
- English: keep Kokoro `af_heart` (local, free, ~8 s for 9 s of audio). Maybe Kokoro `am_michael`, Qwen3-TTS
  VoiceDesign. Dropped GPT-audio cedar/mini, Chatterbox, Qwen-Audio EN, Qwen3 Ryan.
- Chinese: nothing kept. Maybe Qwen-Audio 3 longanlingxin / longanlufeng (`bl speech`), GPT-audio marin
  (OpenRouter). Kokoro zh and local Qwen3 misread words. Still to try for a Taiwan accent: Azure zh-TW, Gemini TTS
  (account needs credits), or cloning the user's voice.
- Always run the Whisper check; a voice that "sounds fine" can drop or swap words.

## Options not taken yet
- Cap (cap.so) for recording: cursor.json with clicks drives zooms. The app is AGPL with a commercial license; ask
  before relying on it.
- Site-to-video: a Playwright script that drives a site and logs a Cap-style cursor.json
  (`~/Workspace/design/hq-video/video/lab/capture.mjs`, unfinished).
- Frame by frame from real components: mount the product's own web UI with fake data instead of re-typing it.
