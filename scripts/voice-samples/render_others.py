#!/usr/bin/env python3
"""Render the three call-style texts with the non-Phonon engines for the voice A/B (see serve/docs/local-voice.md).

    render_others.py <work dir holding kokoro/ and piper/ model files> <out dir> <first file number> [kokoro piper say]

Writes `<n>-<engine>-<voice>-<text>.wav` raw (16-bit mono, the engine's own rate, untouched) and prints one JSON
line per file with time to first audio and real-time factor. The caller level-matches the files afterwards with
`samples normalize`. Engines: Kokoro-82M (Apache-2.0, through kokoro-onnx), Piper voices with a commercial-use
dataset licence, macOS `say` (the installed voices; premium ones are not on CI runners).
Evaluation tooling only: Piper's runtime and Kokoro's espeak-ng phonemiser are GPL, nothing here ships.
"""
import json
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

TEXTS = [
    ("greeting", "Hi, it's your Kith assistant. How can I help you today?"),
    ("numbers", "Your meeting is on Tuesday, October 28th at 3:45 PM, and it should take about 20 minutes."),
    ("answer", "Yes, I checked the report. Revenue grew twelve percent last quarter, mostly from the new subscriptions."),
]


def write_wav(path, samples, rate):
    pcm = (np.clip(samples, -1, 1) * 32767).round().astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def report(path, first, total, seconds):
    print(json.dumps({"file": str(path), "ttfaMs": round(first * 1000), "rtf": round(total / seconds, 3),
                      "seconds": round(seconds, 2)}), flush=True)


def kokoro(work, out, n):
    from kokoro_onnx import Kokoro

    for tag, model, voices in [("kokoro-fp32", "kokoro.onnx", ["af_heart", "af_bella", "am_michael"]),
                               ("kokoro-q8", "kokoro-q8.onnx", ["af_heart"])]:
        engine = Kokoro(str(work / "kokoro" / model), str(work / "kokoro" / "voices-v1.0.bin"))
        engine.create("Warming up.", voice=voices[0], lang="en-us")
        for voice in voices:
            for name, text in TEXTS:
                start = time.perf_counter()
                audio, rate = engine.create(text, voice=voice, speed=1.0, lang="en-us")
                total = time.perf_counter() - start
                path = out / f"{n:02d}-{tag}-{voice}-{name}.wav"
                write_wav(path, audio, rate)
                # Not streamed here: the whole clip is the first audio. kokoro-onnx also has create_stream
                # (sentence by sentence); the app already speaks sentence clips, so total time per clip is the
                # comparable number.
                report(path, total, total, len(audio) / rate)
            n += 1
    return n


def piper(work, out, n):
    from piper import PiperVoice

    for voice in ["en_US-kristin-medium", "en_US-libritts_r-medium"]:
        engine = PiperVoice.load(work / "piper" / f"{voice}.onnx")
        list(engine.synthesize("Warming up."))
        short = voice.split("-")[1]
        for name, text in TEXTS:
            start = time.perf_counter()
            first, chunks = None, []
            for chunk in engine.synthesize(text):
                first = first if first is not None else time.perf_counter() - start
                chunks.append(chunk.audio_int16_array)
                rate = chunk.sample_rate
            total = time.perf_counter() - start
            audio = np.concatenate(chunks).astype(np.float32) / 32768
            path = out / f"{n:02d}-piper-{short}-{name}.wav"
            write_wav(path, audio, rate)
            report(path, first, total, len(audio) / rate)
        n += 1
    return n


def say(out, n):
    voices = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    # Best installed English voices: premium and enhanced first, then the compact defaults.
    names = [l.split("  ")[0].strip() for l in voices.splitlines() if " en_" in l]
    best = [v for v in names if "(Premium)" in v or "(Enhanced)" in v]
    chosen = (best or [v for v in names if v in ("Samantha", "Daniel", "Flo (English (US))")])[:3]
    for voice in chosen:
        for name, text in TEXTS:
            tmp = out / "tmp.aiff"
            start = time.perf_counter()
            if subprocess.run(["say", "-v", voice, "-o", str(tmp), text]).returncode:
                break  # voice listed but its assets aren't installed
            total = time.perf_counter() - start
            path = out / f"{n:02d}-macos-say-{voice.split(' ')[0].lower()}-{name}.wav"
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@22050", str(tmp), str(path)], check=True)
            tmp.unlink()
            with wave.open(str(path)) as w:
                seconds = w.getnframes() / w.getframerate()
            report(path, total, total, seconds)
        n += 1
    return n


if __name__ == "__main__":
    work, out, n = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    only = sys.argv[4:] or ["kokoro", "piper", "say"]
    if "kokoro" in only:
        n = kokoro(work, out, n)
    if "piper" in only:
        n = piper(work, out, n)
    if "say" in only:
        say(out, n)
