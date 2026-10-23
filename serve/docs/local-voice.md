# Local voice

`kith serve` can speak with a model that runs on this Mac: Gradium's Phonon 31M English (Apache-2.0). No cloud
key, nothing leaves the computer. Apple silicon only.

## Pieces

- **`kith-tts`** (`serve/host/crates/tts`): a small helper program. It loads the model and answers JSON lines on
  stdio. It is the only thing that links the `ptts` runtime, so `kith serve` itself doesn't grow, and a crash in
  the model code fails one request instead of taking the Discord and Telegram channels down.
- **`serve/host/src/voice_local.rs`**: starts the helper on the first request, restarts it once if it died, stops
  it after 5 idle minutes, and downloads the model files.

The host looks for `kith-tts` next to its own executable, then in the sibling cargo profile folders
(`../release`, `../debug`), then on `PATH`. A release tarball puts it in `bin/` beside `kith` (arm64 only). In a
checkout: `cargo build --release -p kith-tts` next to `cargo build --release -p kith-serve`.

Every install path puts it beside the host it installs:

- `kith serve start` builds `kith-tts` (dev-app profile) with the host and copies it to `~/.kith/serve/bin/kith-tts`
  by rename, like `kith-serve`; a packaged `kith` copies the `bin/kith-tts` from its tarball. A missing or failed
  build doesn't stop the install: local voice reports unavailable.
- The Mac app builds it in `tools/native-host.mjs` (arm64 only; an Intel build has none) and ships it in
  `Resources/` next to `kith-serve`, which the app's service runs in place.

## Model files

Downloaded on first use (or by `voiceLocalPrepare`) into `<KITH_SERVE_HOME or ~/.kith/serve>/models/phonon-31m-en/`,
about 65 MB: `model.q8.gguf`, config, tokenizer, the default voice and four English voices. Each file comes from a
pinned Hugging Face revision (never `main`), is written to `<name>.part`, hashed while it downloads and renamed
only if the SHA-256 and size match the constants in `voice_local.rs`. A mismatch deletes the file and reports an
error; the next `voiceLocalPrepare` tries again. A `.part` left by a killed host is overwritten.

Only the Apache-2.0 models and voices are listed. Phonon 40M is CC BY-NC and must not be added.

## API

No vault key needed (the `voiceLocal*` methods skip the vault unlock). Paired devices may call them like `voiceSpeak`.

| Method | Body | Answer |
|---|---|---|
| `voiceLocalStatus` | none | `{available, model: "phonon-31m-en", state: "missing" \| "downloading" \| "ready" \| "error", progress?: 0..1, error?, voices: string[], defaultVoice, helperRssBytes?}` |
| `voiceLocalPrepare` | none | starts the download if the model is missing (a second call while one runs starts nothing) and returns the status at once |
| `voiceLocalSpeak` | `{text, voice?}` | `{audio: <base64 WAV, 16-bit mono>, format: "wav", sampleRate: 24000}` |

`text` is 1–4000 bytes. `voiceLocalSpeak` downloads the model first if it is missing and waits. Requests are
answered one at a time, so a call can prefetch the next sentence while one plays. `available` is false off Apple
silicon or when `kith-tts` isn't found, and `error` says which.

## What the clip sounds like

Every clip leaves `kith-tts` through `crates/tts/src/lib.rs`, not straight from the model:

- **Edges**: silence under -50 dBFS is trimmed, then exactly 30 ms lead and 150 ms tail are added back, with a 3 ms
  fade in and 8 ms fade out. The model used to hand out about 500 ms of trailing silence per sentence, which the
  call player (gapless) turned into a half-second hole between sentences.
- **Level**: the clip is brought to -16 LUFS (BS.1770 integrated loudness) with a -1 dBFS peak ceiling and at most
  12 dB of gain. As shipped before, speech sat near -24 LUFS with peaks around -7 dBFS, 8 dB quieter than other
  audio on the phone. A voice with a high crest factor stops at the ceiling a little under the target.
- **16-bit conversion**: rounded with TPDF dither (fixed seed, so the same text encodes to the same bytes) instead
  of truncating toward zero.

Sampler settings are the ptts defaults (temperature 0.3, no CFG: this checkpoint refuses CFG with a precomputed
voice embedding). Phonon has no speed control.

`scripts/voice-samples/` renders the same three call-style texts with Phonon (as shipped, fixed, every voice, f32
weights, other temperatures), Kokoro, Piper and macOS `say`, level-matches them and measures them; the
`Voice samples` workflow runs it on a macOS runner and uploads the files and `index.md`. Kokoro and Piper are
evaluated only: Piper's runtime and Kokoro's espeak-ng phonemiser are GPL and not part of Kith.
