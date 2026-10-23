#!/usr/bin/env python3
"""Markdown index of a voice-sample run: one row per engine/voice, averaged over the three texts.

    index.py <run dir with files/, raw/ and log/*.jsonl>

Peak, clipping, loudness and edge silence are measured on the files as they sit in files/ (level-matched, except
the `shipped` one); engines that were level-matched also show what they produced raw.
"""
import collections
import json
import os
import re
import sys

run = sys.argv[1]


def lines(path):
    return [json.loads(l) for l in open(path) if l.startswith("{")]


def base(d):
    return os.path.basename(d["file"])


def mean(xs):
    return sum(xs) / len(xs)


timing = {}
for name in sorted(os.listdir(run + "/log")):
    if name.startswith("render-"):
        timing.update({base(d): d for d in lines(f"{run}/log/{name}")})
raw = {base(d): d for d in lines(run + "/log/analyze-raw.jsonl")}
final = {base(d): d for d in lines(run + "/log/analyze-final.jsonl")}
rows = collections.OrderedDict()
for f in sorted(final):
    rows.setdefault(re.match(r"(.+)-(?:greeting|numbers|answer)\.wav", f).group(1), []).append(f)
print("| sample | rate Hz | time to first audio ms | real-time factor | peak dBFS | clipped % | LUFS | lead ms | tail ms | raw LUFS / peak |")
print("|---|---|---|---|---|---|---|---|---|---|")
for key, files in rows.items():
    a, t = [final[f] for f in files], [timing[f] for f in files if f in timing]
    r = [raw[f] for f in files if f in raw]
    rawtxt = f"{mean([x['lufs'] for x in r]):.1f} / {max(x['peakDbfs'] for x in r):.1f}" if r else "same"
    print(f"| {key} | {a[0]['sampleRate']} | {mean([x['ttfaMs'] for x in t]):.0f} | {mean([x['rtf'] for x in t]):.2f} | "
          f"{max(x['peakDbfs'] for x in a):.1f} | {max(x['clippedPct'] for x in a):.2f} | {mean([x['lufs'] for x in a]):.1f} | "
          f"{mean([x['leadMs'] for x in a]):.0f} | {mean([x['tailMs'] for x in a]):.0f} | {rawtxt} |")
