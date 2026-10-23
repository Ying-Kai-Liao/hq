//! Voice-sample generator and WAV analyser for comparing call voices.
//!
//! ```text
//! cargo run --release -p kith-tts --example samples -- render <model dir> <out dir> <q8|f32> <first number>
//! cargo run --release -p kith-tts --example samples -- normalize <in.wav> <out.wav>
//! cargo run --release -p kith-tts --example samples -- analyze <wav>...
//! ```
//!
//! `render` writes the same three call-style texts for each Phonon variant of that weight precision as
//! `<n>-<engine>-<voice>-<text>.wav` and prints one JSON line per file with time to first audio and real-time
//! factor. `normalize` gives another engine's 16-bit WAV the same trim and loudness stage the Phonon clips get, so
//! samples differ in voice and not in volume. `analyze` prints one JSON line per 16-bit PCM WAV (any engine, any
//! rate): peak, clipping, loudness and edge silence. Run under `taskpolicy -b`. `scripts/voice-samples.sh` drives
//! the whole set.

#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use kith_tts::{finish, loudness, wav, wav_as_shipped};
use ptts::checkpoint::{Checkpoint, ResolveOptions};
use ptts::preprocess::Lang;
use ptts::synth::{DeviceKind, Quant, SpeechOptions};
use serde_json::json;
use std::time::Instant;

pub const TEXTS: [(&str, &str); 3] = [
    ("greeting", "Hi, it's your Kith assistant. How can I help you today?"),
    ("numbers", "Your meeting is on Tuesday, October 28th at 3:45 PM, and it should take about 20 minutes."),
    (
        "answer",
        "Yes, I checked the report. Revenue grew twelve percent last quarter, mostly from the new subscriptions.",
    ),
];

struct Variant {
    engine: &'static str,
    voice: &'static str,
    shipped: bool,
    temperature: Option<f32>,
    cfg: Option<f32>,
}

fn variants(quant: &str) -> Vec<Variant> {
    let v = |engine, voice, shipped, temperature, cfg| Variant { engine, voice, shipped, temperature, cfg };
    if quant == "q8" {
        let mut all = vec![v("phonon-q8-shipped", "default", true, None, None)];
        for voice in ["default", "zoey", "harper", "easton", "miles"] {
            all.push(v("phonon-q8-fixed", voice, false, None, None));
        }
        all
    } else {
        vec![
            v("phonon-f32-fixed", "default", false, None, None),
            v("phonon-f32-temp01", "default", false, Some(0.1), None),
            v("phonon-f32-temp06", "default", false, Some(0.6), None),
        ]
    }
}

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("render") if args.len() == 5 => render(&args[1], &args[2], &args[3], args[4].parse()?),
        Some("normalize") if args.len() == 3 => {
            let (mono, rate) = read_wav(&args[1])?;
            std::fs::write(&args[2], wav(&finish(&mono, rate), rate))?;
            Ok(())
        }
        Some("analyze") => {
            for path in &args[1..] {
                println!("{}", analyze(path)?);
            }
            Ok(())
        }
        _ => Err("usage: samples render <model dir> <out dir> <q8|f32> <first number> | normalize <in> <out> | analyze <wav>...".into()),
    }
}

fn render(dir: &str, out: &str, quant: &str, first_number: usize) -> Res<()> {
    let q = if quant == "q8" { Quant::Q80 } else { Quant::F32 };
    let checkpoint = Checkpoint::resolve(dir, ResolveOptions { quant: q, weights: None })?;
    let mut tts = checkpoint.builder(Lang::En).device(DeviceKind::Cpu).build()?;
    checkpoint.register_voices(&mut tts);
    let rate = tts.sample_rate();
    std::fs::create_dir_all(out)?;
    // Warm-up so the first measured clip doesn't pay for page-in of the weights.
    tts.say("Warming up.")?;
    for (n, variant) in variants(quant).iter().enumerate() {
        for (name, text) in TEXTS {
            let mut options = SpeechOptions::default().voice(variant.voice);
            if let Some(t) = variant.temperature {
                options = options.temperature(t);
            }
            if let Some(c) = variant.cfg {
                options = options.cfg_coef(c);
            }
            let start = Instant::now();
            let mut pcm = Vec::new();
            let mut first = None;
            for chunk in tts.stream_with(text, &options)? {
                first.get_or_insert_with(|| start.elapsed());
                pcm.extend(chunk?);
            }
            let took = start.elapsed().as_secs_f64();
            let seconds = pcm.len() as f64 / f64::from(rate);
            let bytes = if variant.shipped { wav_as_shipped(&pcm, rate) } else { wav(&finish(&pcm, rate), rate) };
            let file = format!("{out}/{:02}-{}-{}-{name}.wav", n + first_number, variant.engine, variant.voice);
            std::fs::write(&file, bytes)?;
            println!(
                "{}",
                json!({"file": file, "ttfaMs": first.map_or(0.0, |d| d.as_secs_f64() * 1000.0).round(),
                       "rtf": (took / seconds * 1000.0).round() / 1000.0, "seconds": (seconds * 100.0).round() / 100.0})
            );
        }
    }
    Ok(())
}

/// Mono samples (first channel) and rate of a 16-bit PCM WAV.
fn read_wav(path: &str) -> Res<(Vec<f32>, u32)> {
    let (all, rate, channels) = read_pcm16(path)?;
    Ok((all.iter().step_by(channels).map(|&s| f32::from(s) / 32768.0).collect(), rate))
}

fn read_pcm16(path: &str) -> Res<(Vec<i16>, u32, usize)> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" {
        return Err(format!("{path}: not a RIFF WAV").into());
    }
    let (mut at, mut rate, mut channels, mut data) = (12, 0u32, 1usize, &bytes[..0]);
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into()?) as usize;
        let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
        match &bytes[at..at + 4] {
            b"fmt " => {
                channels = usize::from(u16::from_le_bytes(body[2..4].try_into()?));
                rate = u32::from_le_bytes(body[4..8].try_into()?);
                if u16::from_le_bytes(body[14..16].try_into()?) != 16 {
                    return Err(format!("{path}: only 16-bit PCM").into());
                }
            }
            b"data" => data = body,
            _ => {}
        }
        at += 8 + size + (size & 1);
    }
    Ok((data.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect(), rate, channels))
}

fn analyze(path: &str) -> Res<serde_json::Value> {
    let (all, rate, channels) = read_pcm16(path)?;
    let mono: Vec<f32> = all.iter().step_by(channels).map(|&s| f32::from(s) / 32768.0).collect();
    let peak = mono.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let clipped = all.iter().filter(|&&s| s >= i16::MAX - 1 || s <= i16::MIN + 1).count();
    let quiet = |s: &f32| s.abs() <= 0.003_16;
    let lead = mono.iter().take_while(|s| quiet(s)).count();
    let tail = mono.iter().rev().take_while(|s| quiet(s)).count();
    let ms = |n: usize| (n as f64 * 1000.0 / f64::from(rate)).round();
    Ok(json!({
        "file": path, "sampleRate": rate, "seconds": (mono.len() as f64 / f64::from(rate) * 100.0).round() / 100.0,
        "peakDbfs": (20.0 * f64::from(peak).log10() * 10.0).round() / 10.0,
        "clippedPct": (clipped as f64 / all.len().max(1) as f64 * 1e4).round() / 100.0,
        "lufs": (f64::from(loudness(&mono, rate)) * 10.0).round() / 10.0,
        "leadMs": ms(lead), "tailMs": ms(tail),
    }))
}
