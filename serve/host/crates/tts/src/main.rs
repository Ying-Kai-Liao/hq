//! `kith-tts`: Phonon text to speech behind JSON lines on stdio.
//!
//! One request per line in, one answer per line out, in order:
//!
//! ```text
//! {"id":1,"method":"speak","params":{"text":"Hello.","voice":"zoey"}}
//! {"id":1,"result":{"audio":"<base64 WAV>","sampleRate":24000}}
//! {"id":2,"method":"status"}
//! {"id":2,"result":{"rssBytes":123456789,"voices":["default","zoey"]}}
//! {"id":3,"error":"..."}
//! ```
//!
//! The model loads before the first line is read. Usage: `kith-tts <model directory>`.

use base64::{Engine, engine::general_purpose::STANDARD};
use kith_tts::{finish, wav};
use ptts::checkpoint::{Checkpoint, ResolveOptions};
use ptts::preprocess::Lang;
use ptts::synth::{DeviceKind, Quant, SpeechOptions, Synth};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn main() {
    let Some(dir) = std::env::args().nth(1) else {
        eprintln!("usage: kith-tts <model directory>");
        std::process::exit(2);
    };
    let mut tts = match load(&dir) {
        Ok(tts) => tts,
        Err(e) => {
            eprintln!("kith-tts: can't load the model: {e}");
            std::process::exit(1);
        }
    };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = answer(&mut tts, &line);
        if writeln!(out, "{answer}").and_then(|()| out.flush()).is_err() {
            break;
        }
    }
}

fn load(dir: &str) -> Result<Synth, String> {
    let checkpoint =
        Checkpoint::resolve(dir, ResolveOptions { quant: Quant::Q80, weights: None }).map_err(|e| e.to_string())?;
    let mut tts = checkpoint.builder(Lang::En).device(DeviceKind::Cpu).build().map_err(|e| e.to_string())?;
    checkpoint.register_voices(&mut tts);
    Ok(tts)
}

fn answer(tts: &mut Synth, line: &str) -> Value {
    let Ok(req) = serde_json::from_str::<Value>(line) else {
        return json!({"id": null, "error": "request is not JSON"});
    };
    let id = req["id"].clone();
    match run(tts, &req) {
        Ok(result) => json!({"id": id, "result": result}),
        Err(error) => json!({"id": id, "error": error}),
    }
}

fn run(tts: &mut Synth, req: &Value) -> Result<Value, String> {
    match req["method"].as_str() {
        Some("speak") => {
            let text = req["params"]["text"].as_str().ok_or("`text` is required")?;
            let mut options = SpeechOptions::default();
            if let Some(voice) = req["params"]["voice"].as_str() {
                if !tts.voices().iter().any(|v| v == voice) {
                    return Err(format!("unknown voice `{voice}`"));
                }
                options = options.voice(voice);
            }
            let pcm = tts.say_with(text, &options).map_err(|e| e.to_string())?;
            let rate = tts.sample_rate();
            let pcm = finish(&pcm, rate);
            Ok(json!({"audio": STANDARD.encode(wav(&pcm, rate)), "sampleRate": rate}))
        }
        Some("status") => Ok(json!({"rssBytes": rss_bytes(), "voices": tts.voices()})),
        other => Err(format!("unknown method {other:?}")),
    }
}

/// Resident memory of this process, from `ps` (no unsafe code needed); 0 when `ps` can't say.
fn rss_bytes() -> u64 {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map_or(0, |kb| kb * 1024)
}
