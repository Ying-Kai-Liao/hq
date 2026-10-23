#!/bin/sh
# Download the model files run.sh needs into <work dir>. Phonon files are the pinned revisions of voice_local.rs;
# Kokoro and Piper come from their repos' main (evaluation only, nothing here ships).
set -eu
WORK=$1
P=https://huggingface.co/gradium/phonon-31m-en/resolve/8c64b55ec301728e2d1695bfea87a08a267d0c2d
V=https://huggingface.co/gradium/phonon-voices/resolve/da6c9ec0d47be8df5c87c730a3aa97187f3229c3/voices
mkdir -p "$WORK/phonon/voices" "$WORK/kokoro" "$WORK/piper"
get() { [ -s "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; }
get "$P/config.json" "$WORK/phonon/config.json"
get "$P/tokenizer.json" "$WORK/phonon/tokenizer.json"
get "$P/default-voice.safetensors" "$WORK/phonon/default-voice.safetensors"
get "$P/model.q8.gguf" "$WORK/phonon/model.q8.gguf"
get "$P/model.safetensors" "$WORK/phonon/model.safetensors"
for v in zoey:NbpkqMVS3CJeq2j8 harper:4SZHfMpw-p46Ywgs easton:LMDIYE0Oa377Qh6Z miles:d9XCyhjo4JhkHF1d; do
  get "$V/${v#*:}.safetensors" "$WORK/phonon/voices/${v%%:*}.safetensors"
done
(
  cd "$WORK/phonon"
  printf '%s  %s\n' \
    a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae model.q8.gguf \
    8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607 model.safetensors \
    97c7f8c253413574406ab80dd23f49c3ebb2517163b00a9bf86b9c4cf43e7e23 voices/zoey.safetensors \
    | shasum -a 256 -c -
)
K=https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx
get "$K/model.onnx" "$WORK/kokoro/kokoro.onnx"
get "$K/model_quantized.onnx" "$WORK/kokoro/kokoro-q8.onnx"
get https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin "$WORK/kokoro/voices-v1.0.bin"
R=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US
for v in kristin/medium/en_US-kristin-medium libritts_r/medium/en_US-libritts_r-medium; do
  get "$R/$v.onnx" "$WORK/piper/$(basename "$v").onnx"
  get "$R/$v.onnx.json" "$WORK/piper/$(basename "$v").onnx.json"
done
