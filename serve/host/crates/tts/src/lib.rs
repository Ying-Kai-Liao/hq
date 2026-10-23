//! Output stage of `kith-tts`: what happens to the model's float samples before they leave as a WAV.
//!
//! The model hands out `f32` at 24 kHz with whatever level and edge silence it happened to generate. Every clip
//! goes through [`finish`] so consecutive sentences of one call sit at the same loudness with the same short
//! gap between them, and [`wav`] turns the result into 16-bit with rounding and TPDF dither instead of
//! truncating toward zero (which adds a small distortion that is audible on quiet tails).

// Sample counts, rates and levels move between integer and float all through DSP code; every value here is far
// inside the exact range of the float involved.
#![allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use std::f64::consts::PI;

/// Integrated loudness the clips are brought to (speech through a phone speaker or earbuds).
pub const TARGET_LUFS: f32 = -16.0;
/// Highest sample after gain, about -1 dBFS, so the Int16 conversion and any later resampling can't clip.
pub const PEAK_CEILING: f32 = 0.891;
/// Gain is never pushed past this either way: a near-silent clip is more likely a bad generation than a quiet
/// voice, and boosting it would only raise the noise.
const MAX_GAIN_DB: f32 = 12.0;
/// Below this (-50 dBFS) a sample counts as silence when trimming.
const SILENCE: f32 = 0.003_16;
/// Silence kept before the first and after the last audible sample, so clips played back to back always have
/// the same gap (about 180 ms) however much quiet the model generated at either end.
const LEAD_MS: u32 = 30;
const TAIL_MS: u32 = 150;
/// Fades at the cut edges; the last clip of a call ends in a click without them.
const FADE_IN_MS: u32 = 3;
const FADE_OUT_MS: u32 = 8;

fn ms(rate: u32, ms: u32) -> usize {
    (u64::from(rate) * u64::from(ms) / 1000) as usize
}

/// Trim edge silence to a fixed lead/tail, bring the clip to [`TARGET_LUFS`] without passing [`PEAK_CEILING`].
#[must_use]
pub fn finish(samples: &[f32], rate: u32) -> Vec<f32> {
    let Some(first) = samples.iter().position(|s| s.abs() > SILENCE) else {
        return samples.to_vec(); // all quiet: nothing to anchor a trim or a gain on
    };
    let last = samples.iter().rposition(|s| s.abs() > SILENCE).unwrap_or(first);
    let (lead, tail) = (ms(rate, LEAD_MS), ms(rate, TAIL_MS));
    let mut out = vec![0.0; lead];
    out.extend_from_slice(&samples[first..=last]);
    let end = out.len();
    out.resize(end + tail, 0.0);

    let gain = gain_for(&out, rate);
    for s in &mut out {
        *s *= gain;
    }
    let fade_in = ms(rate, FADE_IN_MS).max(1);
    for i in 0..fade_in.min(end - lead) {
        out[lead + i] *= i as f32 / fade_in as f32;
    }
    let fade_out = ms(rate, FADE_OUT_MS).max(1);
    for i in 0..fade_out.min(end - lead) {
        out[end - 1 - i] *= i as f32 / fade_out as f32;
    }
    out
}

/// Linear gain that reaches the target loudness, held back by the peak ceiling and [`MAX_GAIN_DB`].
fn gain_for(samples: &[f32], rate: u32) -> f32 {
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak <= 0.0 {
        return 1.0;
    }
    let want_db = TARGET_LUFS - loudness(samples, rate);
    if !want_db.is_finite() {
        return 1.0;
    }
    let gain = 10f32.powf(want_db.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) / 20.0);
    gain.min(PEAK_CEILING / peak)
}

#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
}

impl Biquad {
    fn run(self, x: &[f64]) -> Vec<f64> {
        let (mut z1, mut z2) = (0.0, 0.0);
        x.iter()
            .map(|&x| {
                let y = self.b[0] * x + z1;
                z1 = self.b[1] * x - self.a[0] * y + z2;
                z2 = self.b[2] * x - self.a[1] * y;
                y
            })
            .collect()
    }
}

/// The two K-weighting stages of ITU-R BS.1770, derived for any sample rate.
fn k_weighting(rate: u32) -> [Biquad; 2] {
    let fs = f64::from(rate);
    let (f0, gain_db, q) = (1_681.974_450_955_533, 3.999_843_853_973_347, 0.707_175_236_955_419_6);
    let k = (PI * f0 / fs).tan();
    let vh = 10f64.powf(gain_db / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
    };
    let (f0, q) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
    let k = (PI * f0 / fs).tan();
    let a0 = 1.0 + k / q + k * k;
    let high_pass = Biquad { b: [1.0, -2.0, 1.0], a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0] };
    [shelf, high_pass]
}

/// Integrated loudness in LUFS (BS.1770-4: K-weighted, 400 ms blocks at 75% overlap, -70 LUFS absolute gate and
/// -10 LU relative gate). A clip shorter than one block is measured whole. `-inf` for silence.
#[must_use]
pub fn loudness(samples: &[f32], rate: u32) -> f32 {
    let [shelf, high_pass] = k_weighting(rate);
    let x: Vec<f64> = samples.iter().map(|&s| f64::from(s)).collect();
    let y = high_pass.run(&shelf.run(&x));
    let power: Vec<f64> = y.iter().map(|v| v * v).collect();
    let block = ms(rate, 400);
    let step = ms(rate, 100).max(1);
    let mean = |s: &[f64]| s.iter().sum::<f64>() / s.len().max(1) as f64;
    let to_lufs = |p: f64| -0.691 + 10.0 * p.log10();
    let blocks: Vec<f64> = if power.len() < block {
        vec![mean(&power)]
    } else {
        (0..=power.len() - block).step_by(step).map(|i| mean(&power[i..i + block])).collect()
    };
    let loud: Vec<f64> = blocks.into_iter().filter(|&p| p > 0.0 && to_lufs(p) > -70.0).collect();
    if loud.is_empty() {
        return f32::NEG_INFINITY;
    }
    let relative = to_lufs(mean(&loud)) - 10.0;
    let kept: Vec<f64> = loud.into_iter().filter(|&p| to_lufs(p) > relative).collect();
    if kept.is_empty() {
        return f32::NEG_INFINITY;
    }
    to_lufs(mean(&kept)) as f32
}

/// Float to 16-bit with rounding and TPDF dither of +-1 LSB. The noise comes from a fixed-seed generator so the
/// same clip always encodes to the same bytes.
#[must_use]
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut uniform = move || {
        // xorshift64*, mapped to [0, 1)
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32 / (1u64 << 24) as f32
    };
    samples
        .iter()
        .map(|s| {
            let dither = uniform() - uniform();
            #[allow(clippy::cast_possible_truncation)]
            let v = (s.clamp(-1.0, 1.0) * f32::from(i16::MAX) + dither).round() as i16;
            v
        })
        .collect()
}

fn container(pcm: impl ExactSizeIterator<Item = i16>, rate: u32) -> Vec<u8> {
    let len = u32::try_from(pcm.len() * 2).unwrap_or(u32::MAX);
    let mut out = Vec::with_capacity(pcm.len() * 2 + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// 16-bit mono PCM in a WAV container.
#[must_use]
pub fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    container(to_i16(samples).into_iter(), rate)
}

/// The conversion kith-tts shipped with before [`finish`]: truncation toward zero, no dither, no level work.
/// Kept only so the sample generator can render "as shipped" next to the fixed version.
#[must_use]
pub fn wav_as_shipped(samples: &[f32], rate: u32) -> Vec<u8> {
    #[allow(clippy::cast_possible_truncation)]
    container(samples.iter().map(|s| (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16), rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 24_000;

    fn sine(seconds: f32, amp: f32) -> Vec<f32> {
        (0..(seconds * RATE as f32) as usize)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 997.0 * i as f32 / RATE as f32).sin())
            .collect()
    }

    #[test]
    fn wav_has_a_valid_header_and_clamps() {
        let w = wav(&[0.0, 1.0, -2.0], RATE);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(&w[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(w[24..28].try_into().unwrap()), 24_000);
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 6);
        assert_eq!(w.len(), 44 + 6);
        let at = |i: usize| i16::from_le_bytes(w[44 + 2 * i..46 + 2 * i].try_into().unwrap());
        assert!(at(0).abs() <= 1, "silence stays within one dither step");
        assert!(at(1) >= i16::MAX - 1);
        assert!(at(2) <= -i16::MAX + 1);
    }

    #[test]
    fn rounds_instead_of_truncating() {
        // 0.7 LSB truncates to 0 every time; rounded and dithered it averages out to 0.7.
        let x = vec![0.7 / f32::from(i16::MAX); 100_000];
        let mean = to_i16(&x).iter().map(|&v| f64::from(v)).sum::<f64>() / x.len() as f64;
        assert!((mean - 0.7).abs() < 0.02, "mean {mean}");
    }

    #[test]
    fn dither_is_deterministic() {
        let x = sine(0.1, 0.01);
        assert_eq!(to_i16(&x), to_i16(&x));
    }

    #[test]
    fn shipped_conversion_truncates() {
        let w = wav_as_shipped(&[0.7 / f32::from(i16::MAX)], RATE);
        assert_eq!(i16::from_le_bytes(w[44..46].try_into().unwrap()), 0);
    }

    #[test]
    fn loudness_of_a_997_hz_sine_matches_bs1770() {
        // BS.1770 reference: a full-scale 997 Hz sine reads -3.01 LUFS.
        let l = loudness(&sine(2.0, 1.0), RATE);
        assert!((l + 3.0).abs() < 0.2, "{l}");
    }

    #[test]
    fn finish_hits_the_target_and_the_ceiling() {
        let out = finish(&sine(1.0, 0.15), RATE);
        let l = loudness(&out, RATE);
        assert!((l - TARGET_LUFS).abs() < 0.7, "{l}");
        assert!(out.iter().all(|s| s.abs() <= PEAK_CEILING + 1e-4));

        let out = finish(&sine(1.0, 1.0), RATE);
        assert!(out.iter().all(|s| s.abs() <= PEAK_CEILING + 1e-4));
    }

    #[test]
    fn finish_gives_every_clip_the_same_edges() {
        let body = sine(0.5, 0.3);
        let mut padded = vec![0.0; 9_000];
        padded.extend_from_slice(&body);
        padded.extend(vec![0.0; 20_000]);
        let a = finish(&padded, RATE);
        let b = finish(&body, RATE);
        assert_eq!(a.len(), b.len());
        // the sine's first and last samples sit under the silence threshold and are trimmed too
        let expected = body.len() + ms(RATE, LEAD_MS) + ms(RATE, TAIL_MS);
        assert!(a.len().abs_diff(expected) <= 3, "{} vs {expected}", a.len());
        assert_eq!(a[0], 0.0);
        assert_eq!(*a.last().unwrap(), 0.0);
    }

    #[test]
    fn finish_leaves_silence_alone() {
        assert_eq!(finish(&[0.0; 100], RATE), vec![0.0; 100]);
        assert_eq!(finish(&[], RATE), Vec::<f32>::new());
    }
}
