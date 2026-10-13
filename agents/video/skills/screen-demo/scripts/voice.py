#!/usr/bin/env python3
"""Voiceover for screen-demo: local Kokoro TTS, Whisper word timings, and a script check.

usage: <tts-python> voice.py "<script text>" <out-prefix> [--voice af_heart] [--speed 1.0] [--lang a]
writes <out-prefix>.wav, <out-prefix>.mp3 and <out-prefix>.words.json ({text, words:[{w,start,end,conf}], wer, diffs})
<tts-python> is a venv with mlx-audio and mlx-whisper (Apple silicon). Default voice af_heart is the user's pick.
Exit code 2 when the transcript doesn't match the script (WER > 0.05): listen, reword or respell, regenerate.
"""
import argparse, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('text'); ap.add_argument('out')
ap.add_argument('--voice', default='af_heart'); ap.add_argument('--speed', default='1.0')
ap.add_argument('--lang', default='a', help='Kokoro lang code: a=US en, b=UK en, z=zh')
ap.add_argument('--model', default='mlx-community/Kokoro-82M-bf16')
a = ap.parse_args()
out = Path(a.out).expanduser().resolve(); out.parent.mkdir(parents=True, exist_ok=True)
bindir = Path(sys.executable).parent

with tempfile.TemporaryDirectory() as td:
    subprocess.run([str(bindir / 'mlx_audio.tts.generate'), '--model', a.model, '--text', a.text, '--voice', a.voice,
                    '--speed', a.speed, '--lang_code', a.lang, '--output_path', td, '--file_prefix', 'v',
                    '--audio_format', 'wav', '--join_audio'], check=True, capture_output=True)
    wav = sorted(Path(td).glob('*.wav'))[0]
    shutil.copy(wav, out.with_suffix('.wav'))
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(out.with_suffix('.wav')), '-b:a', '160k', str(out.with_suffix('.mp3'))], check=True)

import mlx_whisper
r = mlx_whisper.transcribe(str(out.with_suffix('.wav')), path_or_hf_repo='mlx-community/whisper-large-v3-turbo',
                           word_timestamps=True, language='zh' if a.lang == 'z' else 'en')
words = [{'w': w['word'].strip(), 'start': round(w['start'], 3), 'end': round(w['end'], 3), 'conf': round(w.get('probability', 0), 3)}
         for s in r['segments'] for w in s.get('words', [])]

def toks(t):
    return re.findall(r'[一-鿿]|[a-z0-9]+', t.lower())
ref, hyp = toks(a.text), toks(r['text'])
d = [[i + j if not i * j else 0 for j in range(len(hyp) + 1)] for i in range(len(ref) + 1)]
for i in range(1, len(ref) + 1):
    for j in range(1, len(hyp) + 1):
        d[i][j] = min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (ref[i-1] != hyp[j-1]))
wer = round(d[-1][-1] / max(1, len(ref)), 3)
diffs = sorted(set(ref) ^ set(hyp))
res = {'text': a.text, 'asr_text': r['text'].strip(), 'voice': a.voice, 'seconds': words[-1]['end'] if words else 0,
       'wer': wer, 'diffs': diffs, 'words': words}
out.with_suffix('.words.json').write_text(json.dumps(res, indent=1, ensure_ascii=False))
print(json.dumps({k: res[k] for k in ('seconds', 'wer', 'diffs', 'asr_text')}, ensure_ascii=False))
sys.exit(2 if wer > 0.05 else 0)
