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
