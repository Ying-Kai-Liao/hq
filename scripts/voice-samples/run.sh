#!/bin/sh
# Render every engine/voice/text of the voice A/B into <out dir>/files with an index.md beside them.
#   SAMPLES=<built `samples` example> PY=<python with kokoro-onnx, piper-tts, numpy> run.sh <model work dir> <out dir>
# The work dir holds phonon/ (both model.q8.gguf and model.safetensors), kokoro/ and piper/; fetch-models.sh fills
# it. On a shared Mac run it under `taskpolicy -b`; on a CI runner just run it.
set -eu
WORK=$1 OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:-python3}
mkdir -p "$OUT/files" "$OUT/raw" "$OUT/log"
"$SAMPLES" render "$WORK/phonon" "$OUT/files" q8 1 > "$OUT/log/render-1-q8.jsonl"
"$SAMPLES" render "$WORK/phonon" "$OUT/files" f32 7 > "$OUT/log/render-2-f32.jsonl"
"$PY" "$HERE/render_others.py" "$WORK" "$OUT/raw" 10 > "$OUT/log/render-3-others.jsonl"
for f in "$OUT"/raw/*.wav; do "$SAMPLES" normalize "$f" "$OUT/files/$(basename "$f")"; done
"$SAMPLES" analyze "$OUT"/raw/*.wav > "$OUT/log/analyze-raw.jsonl"
"$SAMPLES" analyze "$OUT"/files/*.wav > "$OUT/log/analyze-final.jsonl"
"$PY" "$HERE/index.py" "$OUT" > "$OUT/index.md"
