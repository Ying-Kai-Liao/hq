#!/usr/bin/env bash
# Footage prep for screen-demo. Local ffmpeg may lack drawtext/subtitles; all text belongs in HyperFrames.
#   prep.sh survey <recording> <outdir>             contact sheet (1 frame / 2 s), scene changes, silences, probe
#   prep.sh cut <recording> <start> <dur> <out.mp4> CFR 30 fps H.264 proxy, short GOP so HyperFrames seeks exactly
# Filenames from macOS screen recordings contain a narrow no-break space: pass them with a glob, not typed.
set -euo pipefail
cmd=$1; shift
case "$cmd" in
  survey)
    src=$1; out=$2; mkdir -p "$out"
    ffprobe -v error -show_entries stream=width,height,r_frame_rate,codec_type:format=duration -of compact "$src" > "$out/probe.txt"
    ffmpeg -v error -y -i "$src" -vf "fps=0.5,scale=480:-1,tile=6x6:padding=4" -frames:v 1 "$out/sheet.jpg"
    # screen changes = candidate beats (UIs change little per frame, so the threshold is low)
    ffmpeg -v info -i "$src" -vf "scale=480:-1,select='gt(scene,0.02)',showinfo" -an -f null - 2>&1 \
      | grep -o 'pts_time:[0-9.]*' | cut -d: -f2 > "$out/scenes.txt" || true
    ffmpeg -v info -i "$src" -af silencedetect=noise=-35dB:d=0.6 -vn -f null - 2>&1 \
      | grep -oE 'silence_(start|end): [0-9.]+' > "$out/silences.txt" || true
    echo "$out: probe.txt sheet.jpg scenes.txt ($(wc -l < "$out/scenes.txt") changes) silences.txt"
    ;;
  cut)
    src=$1; ss=$2; dur=$3; out=$4
    ffmpeg -v error -y -ss "$ss" -i "$src" -t "$dur" -r 30 -c:v libx264 -preset medium -crf 16 -g 10 \
      -pix_fmt yuv420p -an -movflags +faststart "$out"
    echo "$out"
    ;;
  *) sed -n 2,5p "$0"; exit 1 ;;
esac
