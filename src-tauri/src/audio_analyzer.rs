//! Exhaust audio DSP for the Yamaha CP3 (890 cc crossplane triple) + Dominator GP3.
//!
//! Pipeline: ffmpeg demuxes only the audio packets of the `.insv` to f32 PCM at 24 kHz
//! (the 25 GB video payload is never copied) -> RPM tracking from the firing-order
//! harmonic series -> quickshift micro-cuts and decel crackle detection -> per-second
//! Action Score -> Smart Clips with auto camera keyframes.
//!
//! CP3 acoustics: 3 cylinders, 4-stroke, even 240° firing, so the dominant exhaust
//! component (order 1.5) sits at RPM / 40 Hz: 150 Hz at 6,000 RPM, 262.5 Hz at 10,500.

use std::{path::Path, process::Stdio, sync::Arc};

use anyhow::{bail, Context, Result};
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use serde::Serialize;
use tokio::process::Command;

use crate::types::{
    CameraAngle, CameraKeyframe, ClipTag, SmartClip, TelemetryFrame, SPECTRUM_BARS, TELEMETRY_HZ,
};

pub const ANALYSIS_SR: u32 = 24_000;
const SR: f32 = ANALYSIS_SR as f32;
/// 50 ms analysis hop.
const HOP: usize = 1_200;
pub const HOP_MS: f64 = 50.0;
const HOPS_PER_SEC: usize = 20;
/// 170 ms window, 5.86 Hz bins: resolves the firing fundamental to ~±60 RPM after interpolation.
const RPM_FFT: usize = 4_096;
const HUD_FFT: usize = 2_048;
/// 5 ms blocks for transient work (quickshift cuts, crackles).
const ENV_BLOCK: usize = 120;
const ENV_BLOCKS_PER_HOP: usize = HOP / ENV_BLOCK;

const FIRING_HZ_PER_RPM: f32 = 1.0 / 40.0;
const RPM_MIN: f32 = 1_000.0;
const RPM_MAX: f32 = 12_500.0;
const HIGH_RPM_FLOOR: f32 = 6_000.0;
const REDLINE_RPM: f32 = 10_500.0;

/// Log-frequency candidate grid for the f0 tracker: 1/48 octave.
const STEPS_PER_OCT: f32 = 48.0;
/// Largest f0 jump per hop the tracker allows (0.58 oct): a 1st->2nd upshift drops ~26 %.
const MAX_STEP: usize = 28;
/// Viterbi transition cost per octave of jump.
const JUMP_COST_PER_OCT: f32 = 5.0;
const SHS_HARMONICS: usize = 6;
const SHS_DECAY: f32 = 0.84;

// ---------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------

async fn probe_duration_s(path: &Path) -> Option<f64> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"])
        .arg(path)
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Decodes the first audio stream of any container ffmpeg reads (`.insv`, `.m4a`, `.wav`)
/// into planar f32 at [`ANALYSIS_SR`], streaming: PCM is deinterleaved as it arrives, so peak
/// memory is the output itself (24 kHz mono f32 = 5.8 MB per minute) instead of output plus
/// a raw byte copy. ffmpeg's mp4 demuxer reads audio packets only; the video payload is never
/// copied, and Insta360's proprietary trailer after `moov` is ignored by it. With
/// `channels = 1` ffmpeg downmixes.
pub async fn decode_pcm(path: &Path, channels: u16, on_progress: impl Fn(f64)) -> Result<Vec<Vec<f32>>> {
    use tokio::io::AsyncReadExt;
    let duration = probe_duration_s(path).await;
    let mut child = Command::new("ffmpeg")
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac"])
        .arg(channels.to_string())
        .arg("-ar")
        .arg(ANALYSIS_SR.to_string())
        .args(["-f", "f32le", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("ffmpeg is not installed or not on PATH")?;
    let mut stdout = child.stdout.take().context("ffmpeg stdout not captured")?;
    let mut stderr = child.stderr.take().context("ffmpeg stderr not captured")?;
    let err_task = tokio::spawn(async move {
        let mut e = String::new();
        let _ = stderr.read_to_string(&mut e).await;
        e
    });

    let ch = usize::from(channels.max(1));
    let expected = duration.map_or(0, |d| (d * f64::from(ANALYSIS_SR)) as usize + ANALYSIS_SR as usize);
    let mut planes: Vec<Vec<f32>> = (0..ch).map(|_| Vec::with_capacity(expected)).collect();
    let mut buf = vec![0u8; 1 << 20];
    let mut carry: Vec<u8> = Vec::with_capacity(4 * ch);
    let mut idx = 0usize;
    let mut last_report = 0usize;
    loop {
        let n = stdout.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 4 * 4;
        for b in carry[..whole].as_chunks::<4>().0 {
            planes[idx % ch].push(f32::from_le_bytes(*b));
            idx += 1;
        }
        carry.drain(..whole);
        let done = planes[0].len();
        if expected > 0 && done - last_report > ANALYSIS_SR as usize * 5 {
            last_report = done;
            on_progress((done as f64 / expected as f64).min(1.0));
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        bail!("ffmpeg could not decode the audio of {}: {}", path.display(), err_task.await.unwrap_or_default().trim());
    }
    if planes[0].is_empty() {
        bail!("{} has no decodable audio", path.display());
    }
    on_progress(1.0);
    Ok(planes)
}

pub fn downmix(planes: &[Vec<f32>]) -> Vec<f32> {
    let n = planes.iter().map(Vec::len).min().unwrap_or(0);
    let k = 1.0 / planes.len().max(1) as f32;
    (0..n).map(|i| planes.iter().map(|p| p[i]).sum::<f32>() * k).collect()
}

// ---------------------------------------------------------------------------------------
// DSP primitives
// ---------------------------------------------------------------------------------------

struct Stft {
    n: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    norm: f32,
    buf: Vec<Complex32>,
    scratch: Vec<Complex32>,
}

impl Stft {
    fn new(n: usize) -> Self {
        let fft = FftPlanner::new().plan_fft_forward(n);
        let window: Vec<f32> = (0..n)
            .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos())
            .collect();
        let norm = 2.0 / window.iter().sum::<f32>();
        let scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
        Self { n, fft, window, norm, buf: vec![Complex32::default(); n], scratch }
    }

    /// Amplitude spectrum (`n/2 + 1` bins, sine of amplitude A reads ~A) of the frame centered
    /// on `center`, zero-padded outside the signal.
    fn magnitude(&mut self, x: &[f32], center: usize, mag: &mut [f32]) {
        let start = center as isize - (self.n / 2) as isize;
        for (i, (b, w)) in self.buf.iter_mut().zip(&self.window).enumerate() {
            let idx = start + i as isize;
            let s = if idx >= 0 { x.get(idx as usize).copied().unwrap_or(0.0) } else { 0.0 };
            *b = Complex32::new(s * w, 0.0);
        }
        self.fft.process_with_scratch(&mut self.buf, &mut self.scratch);
        for (m, c) in mag.iter_mut().zip(&self.buf) {
            *m = c.norm() * self.norm;
        }
    }

    fn bin_hz(&self) -> f32 {
        SR / self.n as f32
    }
}

/// RBJ biquad, direct form I.
#[derive(Clone, Copy)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Biquad {
    fn highpass(f0: f32, q: f32) -> Self {
        let w = std::f32::consts::TAU * f0 / SR;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b: [(1.0 + c) / 2.0 / a0, -(1.0 + c) / a0, (1.0 + c) / 2.0 / a0],
            a: [-2.0 * c / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn process(&mut self, v: f32) -> f32 {
        let y = self.b[0] * v + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [v, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

fn db(power_or_amp_sq: f32) -> f32 {
    10.0 * power_or_amp_sq.max(1e-12).log10()
}

fn rms_sq(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32
}

fn percentile(values: &[f32], p: f32) -> f32 {
    let mut v: Vec<f32> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f32::total_cmp);
    v[((v.len() - 1) as f32 * p.clamp(0.0, 1.0)).round() as usize]
}

/// Prefix-sum moving average over `[i - before, i + after]`.
fn moving_mean(x: &[f32], before: usize, after: usize) -> Vec<f32> {
    let mut pre = Vec::with_capacity(x.len() + 1);
    pre.push(0.0f64);
    for v in x {
        pre.push(pre[pre.len() - 1] + f64::from(*v));
    }
    (0..x.len())
        .map(|i| {
            let lo = i.saturating_sub(before);
            let hi = (i + after + 1).min(x.len());
            ((pre[hi] - pre[lo]) / (hi - lo) as f64) as f32
        })
        .collect()
}

fn interp_bin(mag: &[f32], bin: f32) -> f32 {
    let i = bin.floor() as usize;
    match (mag.get(i), mag.get(i + 1)) {
        (Some(a), Some(b)) => a + (b - a) * (bin - i as f32),
        _ => 0.0,
    }
}

// ---------------------------------------------------------------------------------------
// Exhaust analysis
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AudioEventKind {
    /// Quickshifter upshift: ignition micro-cut followed by a gear-ratio RPM drop.
    Upshift,
    /// Dominator GP3 deceleration crackle.
    Pop,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioEvent {
    pub timestamp_ms: f64,
    pub kind: AudioEventKind,
    /// Upshift: RPM before the shift. Pop: dB above the local crackle-band background.
    pub magnitude: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExhaustAnalysis {
    pub duration_ms: f64,
    pub hop_ms: f64,
    /// Engine RPM per 50 ms hop, 0 where the tracker has no confident pitch.
    pub rpm: Vec<f32>,
    /// Action Score 0..100 per second of source.
    pub action_score: Vec<f32>,
    pub events: Vec<AudioEvent>,
    /// Full-band level per hop, dBFS (used to snap clip boundaries on quiet points).
    #[serde(skip)]
    pub level_db: Vec<f32>,
}

/// Per-hop features from one STFT pass.
struct HopFeatures {
    level_db: Vec<f32>,
    /// Energy of the firing-order band (20..700 Hz): drops on throttle closure.
    low_db: Vec<f32>,
    rpm: Vec<f32>,
}

pub fn analyze_exhaust(x: &[f32]) -> ExhaustAnalysis {
    analyze_exhaust_with_progress(x, &|_| ())
}

/// `progress` receives 0..1 while the RPM tracker (the expensive part) runs.
pub fn analyze_exhaust_with_progress(x: &[f32], progress: &dyn Fn(f64)) -> ExhaustAnalysis {
    let n_hops = x.len().div_ceil(HOP);
    let hop = track_rpm(x, n_hops, progress);
    let env = TransientEnvelope::new(x);

    let mut events = detect_upshifts(&hop.rpm, &env);
    let decel = decel_flags(&hop);
    events.extend(detect_pops(&env, &decel));
    events.sort_by(|a, b| a.timestamp_ms.total_cmp(&b.timestamp_ms));

    let action_score = action_scores(&hop, &events);
    ExhaustAnalysis {
        duration_ms: x.len() as f64 * 1000.0 / f64::from(ANALYSIS_SR),
        hop_ms: HOP_MS,
        rpm: hop.rpm,
        action_score,
        events,
        level_db: hop.level_db,
    }
}

/// Subharmonic-summation pitch salience on a log grid + Viterbi path through it.
/// The continuity prior is what kills octave errors (f0/2, f0/3 from the cycle order).
fn track_rpm(x: &[f32], n_hops: usize, progress: &dyn Fn(f64)) -> HopFeatures {
    let f_min = RPM_MIN * FIRING_HZ_PER_RPM;
    let f_max = RPM_MAX * FIRING_HZ_PER_RPM;
    let n_states = ((f_max / f_min).log2() * STEPS_PER_OCT).ceil() as usize + 1;
    let grid: Vec<f32> = (0..n_states).map(|i| f_min * (i as f32 / STEPS_PER_OCT).exp2()).collect();

    let mut stft = Stft::new(RPM_FFT);
    let bin_hz = stft.bin_hz();
    let mut mag = vec![0.0f32; RPM_FFT / 2 + 1];
    let mut sal = vec![0.0f32; n_states];
    let mut prev = vec![0.0f32; n_states];
    let mut cur = vec![0.0f32; n_states];
    // back[t * n_states + j] = jump offset + MAX_STEP of the best predecessor.
    let mut back = vec![0u8; n_hops * n_states];
    let mut confidence = vec![0.0f32; n_hops];
    let mut level_db = vec![-120.0f32; n_hops];
    let mut low_db = vec![-120.0f32; n_hops];
    let low_hi_bin = (700.0 / bin_hz) as usize;
    let low_lo_bin = (20.0 / bin_hz).ceil() as usize;

    for t in 0..n_hops {
        if t % 1_200 == 0 {
            progress(t as f64 / n_hops.max(1) as f64);
        }
        let center = t * HOP + HOP / 2;
        let seg = &x[(t * HOP).min(x.len())..((t + 1) * HOP).min(x.len())];
        level_db[t] = db(rms_sq(seg));
        stft.magnitude(x, center, &mut mag);
        low_db[t] = db(mag[low_lo_bin..=low_hi_bin].iter().map(|m| m * m).sum::<f32>());

        // Salience: log-compressed spectrum relative to the frame peak, harmonic-weighted.
        let peak = mag.iter().copied().fold(1e-9f32, f32::max);
        for (s, &f) in sal.iter_mut().zip(&grid) {
            let mut acc = 0.0;
            let mut w = 1.0;
            for k in 1..=SHS_HARMONICS {
                let b = f * k as f32 / bin_hz;
                if b >= (mag.len() - 2) as f32 {
                    break;
                }
                acc += w * (1.0 + 100.0 * interp_bin(&mag, b) / peak).ln();
                w *= SHS_DECAY;
            }
            *s = acc;
        }
        let mean = sal.iter().sum::<f32>() / n_states as f32;
        let sd = (sal.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n_states as f32).sqrt().max(1e-6);
        let mut zmax = f32::MIN;
        for s in sal.iter_mut() {
            *s = (*s - mean) / sd;
            zmax = zmax.max(*s);
        }
        confidence[t] = zmax;

        for j in 0..n_states {
            let lo = j.saturating_sub(MAX_STEP);
            let hi = (j + MAX_STEP).min(n_states - 1);
            let (mut best, mut arg) = (f32::MIN, j);
            for (i, &p) in prev.iter().enumerate().take(hi + 1).skip(lo) {
                let v = p - JUMP_COST_PER_OCT * (i as f32 - j as f32).abs() / STEPS_PER_OCT;
                if v > best {
                    best = v;
                    arg = i;
                }
            }
            cur[j] = if t == 0 { sal[j] } else { best + sal[j] };
            back[t * n_states + j] = (arg + MAX_STEP - j) as u8;
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    // Backtrack.
    let mut state = prev
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map_or(0, |(i, _)| i);
    let mut path = vec![0usize; n_hops];
    for t in (0..n_hops).rev() {
        path[t] = state;
        state = (state + usize::from(back[t * n_states + state])).saturating_sub(MAX_STEP);
    }

    // Gate: engine audible (absolute, so a file that is WOT throughout still tracks) and a
    // peaky harmonic salience.
    let raw: Vec<f32> = (0..n_hops)
        .map(|t| {
            if level_db[t] > -60.0 && confidence[t] > 2.8 {
                grid[path[t]] / FIRING_HZ_PER_RPM
            } else {
                0.0
            }
        })
        .collect();
    // 3-tap median removes single-hop glitches without smearing shift drops.
    let rpm = (0..n_hops)
        .map(|t| {
            let mut w = [
                raw[t.saturating_sub(1)],
                raw[t],
                raw[(t + 1).min(n_hops.saturating_sub(1))],
            ];
            w.sort_by(f32::total_cmp);
            w[1]
        })
        .collect();
    HopFeatures { level_db, low_db, rpm }
}

/// 5 ms envelopes: full band, and the crackle band (biquad HPF at 1.5 kHz).
struct TransientEnvelope {
    full_db: Vec<f32>,
    hp_db: Vec<f32>,
    hp_peak: Vec<f32>,
}

impl TransientEnvelope {
    fn new(x: &[f32]) -> Self {
        let (mut hp1, mut hp2) = (Biquad::highpass(1_500.0, 0.707), Biquad::highpass(1_500.0, 0.707));
        let n = x.len().div_ceil(ENV_BLOCK);
        let (mut full_db, mut hp_db, mut hp_peak) =
            (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
        for block in x.chunks(ENV_BLOCK) {
            let (mut e, mut p) = (0.0f32, 0.0f32);
            for &v in block {
                let h = hp2.process(hp1.process(v));
                e += h * h;
                p = p.max(h.abs());
            }
            full_db.push(db(rms_sq(block)));
            hp_db.push(db(e / block.len() as f32));
            hp_peak.push(p);
        }
        Self { full_db, hp_db, hp_peak }
    }

    fn block_ms(i: usize) -> f64 {
        (i * ENV_BLOCK) as f64 * 1000.0 / f64::from(ANALYSIS_SR)
    }
}

/// Upshift = the RPM was climbing, drops by a CP3 gear-ratio step (MT-09 Gen 3: 2nd->3rd
/// ~21 %, 5th->6th ~11 %) within 150 ms, and climbs again. A 30..120 ms ignition cut in the
/// 5 ms envelope confirms it and raises the event magnitude.
fn detect_upshifts(rpm: &[f32], env: &TransientEnvelope) -> Vec<AudioEvent> {
    let mut out = Vec::new();
    let mut t = 9;
    while t + 9 < rpm.len() {
        let before = rpm[t - 1];
        let climb = before - rpm[t - 9];
        let after_min = rpm[t..t + 3].iter().copied().filter(|v| *v > 0.0).fold(f32::MAX, f32::min);
        let ratio = after_min / before.max(1.0);
        let recovering = rpm[t + 8] > after_min * 1.02;
        if before > 4_500.0
            && rpm[t - 9] > 0.0
            && climb > 150.0
            && (0.68..=0.93).contains(&ratio)
            && recovering
        {
            let b0 = (t * ENV_BLOCKS_PER_HOP).saturating_sub(20);
            let b1 = ((t + 2) * ENV_BLOCKS_PER_HOP).min(env.full_db.len());
            let pre = &env.full_db[b0.saturating_sub(20)..b0];
            let pre_db = pre.iter().sum::<f32>() / pre.len().max(1) as f32;
            let (cut_idx, cut_db) = env.full_db[b0..b1]
                .iter()
                .enumerate()
                .min_by(|a, b| a.1.total_cmp(b.1))
                .map_or((0, pre_db), |(i, v)| (b0 + i, *v));
            let has_cut = pre_db - cut_db > 5.0;
            out.push(AudioEvent {
                timestamp_ms: if has_cut { TransientEnvelope::block_ms(cut_idx) } else { t as f64 * HOP_MS },
                kind: AudioEventKind::Upshift,
                magnitude: before,
            });
            t += 10; // 500 ms refractory
        } else {
            t += 1;
        }
    }
    out
}

/// Throttle closed / engine braking: RPM falling > 400 RPM/s over 0.5 s, or the firing band
/// collapsed by > 5 dB versus the previous second. Widened by 2 s so crackles that follow the
/// closure still count.
fn decel_flags(hop: &HopFeatures) -> Vec<bool> {
    let n = hop.rpm.len();
    let low_recent = moving_mean(&hop.low_db, 5, 0);
    let raw: Vec<bool> = (0..n)
        .map(|t| {
            if t < 26 {
                return false;
            }
            let (a, b) = (hop.rpm[t - 10], hop.rpm[t]);
            let rpm_fall = a > 0.0 && b > 0.0 && (b - a) / 0.5 < -400.0;
            let prev = hop.low_db[t - 26..t - 6].iter().sum::<f32>() / 20.0;
            rpm_fall || prev - low_recent[t] > 5.0
        })
        .collect();
    let mut out = vec![false; n];
    let mut last = None;
    for t in 0..n {
        if raw[t] {
            last = Some(t);
        }
        out[t] = last.is_some_and(|l| t - l <= 40);
    }
    out
}

/// Crackle: a crackle-band block > 9 dB above its 400 ms background, crest factor > 4,
/// local maximum over ±15 ms, inside a deceleration phase, 25 ms refractory.
#[allow(clippy::needless_range_loop)] // indexes four parallel envelopes
fn detect_pops(env: &TransientEnvelope, decel: &[bool]) -> Vec<AudioEvent> {
    let bg = moving_mean(&env.hp_db, 40, 40);
    let mut out = Vec::new();
    let mut last: Option<usize> = None;
    for i in 3..env.hp_db.len().saturating_sub(3) {
        let lift = env.hp_db[i] - bg[i];
        if lift < 9.0 || !decel.get(i / ENV_BLOCKS_PER_HOP).copied().unwrap_or(false) {
            continue;
        }
        if env.hp_db[i - 3..=i + 3].iter().any(|v| *v > env.hp_db[i]) {
            continue;
        }
        let local_rms = (env.hp_db[i - 2..=i + 1].iter().map(|d| 10f32.powf(d / 10.0)).sum::<f32>() / 4.0).sqrt();
        if env.hp_peak[i] / local_rms.max(1e-9) < 4.0 {
            continue;
        }
        if last.is_some_and(|l| i - l < 5) {
            continue;
        }
        last = Some(i);
        out.push(AudioEvent {
            timestamp_ms: TransientEnvelope::block_ms(i),
            kind: AudioEventKind::Pop,
            magnitude: lift,
        });
    }
    out
}

/// Action Score per second, 0..100:
/// 32 % high-RPM position (6,000 -> 10,500), 18 % climb rate (3,000 RPM/s = full),
/// 28 % crackle density (6 pops/s = full), 10 % quickshift, 12 % loudness rank.
fn action_scores(hop: &HopFeatures, events: &[AudioEvent]) -> Vec<f32> {
    let n_sec = hop.rpm.len().div_ceil(HOPS_PER_SEC);
    let p10 = percentile(&hop.level_db, 0.10);
    let p95 = percentile(&hop.level_db, 0.95);
    let mut pops = vec![0u32; n_sec];
    let mut shifts = vec![false; n_sec];
    for e in events {
        let s = ((e.timestamp_ms / 1000.0) as usize).min(n_sec.saturating_sub(1));
        match e.kind {
            AudioEventKind::Pop => pops[s] += 1,
            AudioEventKind::Upshift => shifts[s] = true,
        }
    }
    (0..n_sec)
        .map(|s| {
            let r = s * HOPS_PER_SEC..((s + 1) * HOPS_PER_SEC).min(hop.rpm.len());
            let rpm_max = hop.rpm[r.clone()].iter().copied().fold(0.0, f32::max);
            let climb = r
                .clone()
                .filter(|&t| t >= 10 && hop.rpm[t] > 0.0 && hop.rpm[t - 10] > 0.0)
                .map(|t| (hop.rpm[t] - hop.rpm[t - 10]) / 0.5)
                .fold(0.0, f32::max);
            let level = hop.level_db[r.clone()].iter().sum::<f32>() / r.len().max(1) as f32;
            let rpm_term = ((rpm_max - HIGH_RPM_FLOOR) / (REDLINE_RPM - HIGH_RPM_FLOOR)).clamp(0.0, 1.0);
            let climb_term = (climb / 3_000.0).clamp(0.0, 1.0);
            let pop_term = (pops[s] as f32 / 6.0).min(1.0);
            let shift_term = if shifts[s] { 1.0 } else { 0.0 };
            let loud_term = ((level - p10) / (p95 - p10).max(1.0)).clamp(0.0, 1.0);
            100.0 * (0.32 * rpm_term + 0.18 * climb_term + 0.28 * pop_term + 0.10 * shift_term + 0.12 * loud_term)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// HUD audio features (60 fps, merged into TelemetryFrame)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct HudAudioFrame {
    pub rms: f32,
    pub bars: [f32; SPECTRUM_BARS],
}

/// 24 log-spaced bars from 35 Hz to 6 kHz: the CP3 firing fundamental (25..300 Hz), its
/// harmonics, and the GP3 crackle band. Release ballistics are baked in here so the React
/// preview and the exported HUD read identical values.
pub fn hud_audio_frames(x: &[f32]) -> Vec<HudAudioFrame> {
    let hop = (f64::from(ANALYSIS_SR) / TELEMETRY_HZ).round() as usize;
    let n = x.len().div_ceil(hop);
    let mut stft = Stft::new(HUD_FFT);
    let bin_hz = stft.bin_hz();
    let mut mag = vec![0.0f32; HUD_FFT / 2 + 1];
    let (f_lo, f_hi) = (35.0f32, 6_000.0f32);
    let edges: Vec<f32> = (0..=SPECTRUM_BARS)
        .map(|i| f_lo * (f_hi / f_lo).powf(i as f32 / SPECTRUM_BARS as f32))
        .collect();
    let bands: Vec<(usize, usize)> = edges
        .windows(2)
        .map(|e| {
            let lo = (e[0] / bin_hz).ceil() as usize;
            let hi = (e[1] / bin_hz).floor() as usize;
            if hi >= lo {
                (lo, hi)
            } else {
                let c = ((e[0] * e[1]).sqrt() / bin_hz).round() as usize;
                (c, c)
            }
        })
        .collect();
    let mut held = [0.0f32; SPECTRUM_BARS];
    let mut out = Vec::with_capacity(n);
    for f in 0..n {
        let center = f * hop;
        stft.magnitude(x, center, &mut mag);
        for (b, &(lo, hi)) in bands.iter().enumerate() {
            let p = mag[lo..=hi].iter().map(|m| m * m).sum::<f32>() / (hi - lo + 1) as f32;
            let v = ((db(p) + 70.0) / 60.0).clamp(0.0, 1.0);
            held[b] = v.max(held[b] * 0.88);
        }
        let seg = &x[center.saturating_sub(hop)..(center + hop).min(x.len())];
        let rms = ((db(rms_sq(seg)) + 60.0) / 60.0).clamp(0.0, 1.0);
        out.push(HudAudioFrame { rms, bars: held });
    }
    out
}

// ---------------------------------------------------------------------------------------
// Helmet voice activity
// ---------------------------------------------------------------------------------------

/// Voice activity per 50 ms hop: 300..3400 Hz band > 10 dB above a 3 s minimum-statistics
/// noise floor and harmonic (spectral flatness < 0.45), which rejects broadband wind roar.
/// Opens after 150 ms, holds 300 ms.
pub fn detect_voice(v: &[f32]) -> Vec<bool> {
    let n = v.len().div_ceil(HOP);
    let mut stft = Stft::new(1_024);
    let bin_hz = stft.bin_hz();
    let mut mag = vec![0.0f32; 513];
    let (lo, hi) = ((300.0 / bin_hz) as usize, (3_400.0 / bin_hz) as usize);
    let mut band_db = Vec::with_capacity(n);
    let mut flat = Vec::with_capacity(n);
    for t in 0..n {
        stft.magnitude(v, t * HOP + HOP / 2, &mut mag);
        let p: Vec<f32> = mag[lo..=hi].iter().map(|m| m * m + 1e-12).collect();
        let am = p.iter().sum::<f32>() / p.len() as f32;
        let gm = (p.iter().map(|x| x.ln()).sum::<f32>() / p.len() as f32).exp();
        band_db.push(db(am));
        flat.push(gm / am);
    }
    let smooth = moving_mean(&band_db, 1, 1);
    let raw: Vec<bool> = (0..n)
        .map(|t| {
            let floor = smooth[t.saturating_sub(60)..=t].iter().copied().fold(f32::MAX, f32::min);
            smooth[t] > floor + 10.0 && flat[t] < 0.45
        })
        .collect();
    let mut out = vec![false; n];
    let (mut run, mut hold) = (0usize, 0usize);
    for t in 0..n {
        run = if raw[t] { run + 1 } else { 0 };
        if run >= 3 {
            hold = 6;
            for o in out.iter_mut().take(t + 1).skip(t + 1 - run) {
                *o = true;
            }
        } else if hold > 0 {
            hold -= 1;
            out[t] = true;
        }
    }
    out
}

/// Maps an external recording onto the camera timeline (nearest sample; adequate for VAD).
pub fn align_external(ext: &[f32], len: usize, sync: &SyncResult) -> Vec<f32> {
    let off = sync.offset_ms * f64::from(ANALYSIS_SR) / 1000.0;
    let rate = 1.0 + sync.drift_ppm * 1e-6;
    (0..len)
        .map(|i| {
            let j = (off + i as f64 * rate).round();
            if j >= 0.0 { ext.get(j as usize).copied().unwrap_or(0.0) } else { 0.0 }
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// External phone track sync
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    /// external_time_ms = insv_time_ms * (1 + drift) + offset_ms
    pub offset_ms: f64,
    pub drift_ppm: f64,
    /// Correlation peak over the best competing peak (> 1.5 is a confident lock).
    pub confidence: f32,
}

const ENV_SAMPLES: usize = (ANALYSIS_SR / 1000) as usize; // 1 ms envelope

/// Onset strength at 1 kHz: half-wave rectified derivative of the log-energy. Throttle blips
/// are sharp onsets on both mics even though their spectra (under-seat lav vs helmet phone)
/// share little; correlating onsets instead of waveforms is what makes that pair lock.
fn onset_envelope(x: &[f32]) -> Vec<f32> {
    let e: Vec<f32> = x.chunks(ENV_SAMPLES).map(|c| db(rms_sq(c))).collect();
    let e = moving_mean(&e, 2, 2);
    let mut d: Vec<f32> = std::iter::once(0.0).chain(e.windows(2).map(|w| (w[1] - w[0]).max(0.0))).collect();
    let mean = d.iter().sum::<f32>() / d.len().max(1) as f32;
    let sd = (d.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / d.len().max(1) as f32).sqrt().max(1e-6);
    for v in &mut d {
        *v = (*v - mean) / sd;
    }
    d
}

/// Lag (in envelope samples, sub-sample) maximizing sum a[i] * b[i + lag], plus peak ratio.
fn xcorr_peak(a: &[f32], b: &[f32]) -> Option<(f64, f32)> {
    if a.is_empty() || b.is_empty() {
        return None;
    }
    let n = (a.len() + b.len()).next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let (fwd, inv) = (planner.plan_fft_forward(n), planner.plan_fft_inverse(n));
    let pad = |s: &[f32]| {
        let mut v: Vec<Complex32> = s.iter().map(|x| Complex32::new(*x, 0.0)).collect();
        v.resize(n, Complex32::default());
        v
    };
    let (mut fa, mut fb) = (pad(a), pad(b));
    fwd.process(&mut fa);
    fwd.process(&mut fb);
    let mut c: Vec<Complex32> = fa.iter().zip(&fb).map(|(x, y)| x.conj() * y).collect();
    inv.process(&mut c);
    let lag_of = |k: usize| if k < b.len() { k as i64 } else { k as i64 - n as i64 };
    let valid = |k: usize| {
        let l = lag_of(k);
        l > -(a.len() as i64) && l < b.len() as i64
    };
    let (k, peak) = (0..n).filter(|&k| valid(k)).map(|k| (k, c[k].re)).max_by(|x, y| x.1.total_cmp(&y.1))?;
    let lag = lag_of(k);
    let second = (0..n)
        .filter(|&k| valid(k) && (lag_of(k) - lag).abs() > 50)
        .map(|k| c[k].re)
        .fold(f32::MIN, f32::max);
    let (ym, yp) = (c[(k + n - 1) % n].re, c[(k + 1) % n].re);
    let denom = ym - 2.0 * peak + yp;
    let frac = if denom.abs() > 1e-9 { 0.5 * (ym - yp) / denom } else { 0.0 };
    Some((lag as f64 + f64::from(frac), peak / second.max(1e-6)))
}

/// Offset from the first 60 s of the camera audio searched over the first 180 s of the phone
/// (phone may start up to 120 s earlier or 60 s later), then drift from a second 30 s window
/// near the end of the overlap.
pub fn sync_external(reference: &[f32], external: &[f32]) -> Result<SyncResult> {
    let ea = onset_envelope(reference);
    let eb = onset_envelope(external);
    let a1 = &ea[..ea.len().min(60_000)];
    let b1 = &eb[..eb.len().min(180_000)];
    let (offset1, confidence) = xcorr_peak(a1, b1).context("empty audio for sync")?;
    if confidence < 1.5 {
        bail!("sync failed: no distinctive throttle blips in the first 60 s (peak ratio {confidence:.2})");
    }

    let mut drift_ppm = 0.0;
    let overlap_end = (ea.len() as f64).min(eb.len() as f64 - offset1) as i64;
    let t2 = overlap_end - 35_000;
    if t2 > 120_000 {
        let lo = (t2 as f64 + offset1) as i64 - 3_000;
        let hi = lo + 36_000;
        if lo >= 0 && (hi as usize) <= eb.len() {
            let a2 = &ea[t2 as usize..t2 as usize + 30_000];
            if let Some((lag2, conf2)) = xcorr_peak(a2, &eb[lo as usize..hi as usize]) {
                let offset2 = lo as f64 + lag2 - t2 as f64;
                let d = (offset2 - offset1) / t2 as f64 * 1e6;
                if conf2 >= 1.5 && d.abs() < 1_000.0 {
                    drift_ppm = d;
                }
            }
        }
    }
    Ok(SyncResult { offset_ms: offset1, drift_ppm, confidence })
}

// ---------------------------------------------------------------------------------------
// Waveform peaks for the timeline
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Waveform {
    pub peaks_per_second: u32,
    /// (min, max) pairs.
    pub exhaust: Vec<[f32; 2]>,
    pub voice: Option<Vec<[f32; 2]>>,
}

pub fn waveform_peaks(x: &[f32], peaks_per_second: u32) -> Vec<[f32; 2]> {
    let block = (ANALYSIS_SR / peaks_per_second.max(1)) as usize;
    x.chunks(block)
        .map(|c| c.iter().fold([0.0f32, 0.0], |[lo, hi], v| [lo.min(*v), hi.max(*v)]))
        .collect()
}

// ---------------------------------------------------------------------------------------
// Smart Clips
// ---------------------------------------------------------------------------------------

pub struct ClipContext<'a> {
    pub analysis: &'a ExhaustAnalysis,
    /// Per-hop voice activity on the camera timeline.
    pub voice_active: Option<&'a [bool]>,
    /// 60 Hz frames starting at 0 ms (may be empty when the file has no IMU).
    pub telemetry: &'a [TelemetryFrame],
}

const CLIP_LENGTHS_S: [usize; 5] = [12, 15, 18, 21, 25];
const MAX_CLIPS: usize = 10;
const MIN_CLIPS: usize = 5;
const LEAN_TAG_DEG: f64 = 35.0;

fn frame_at(tel: &[TelemetryFrame], t_ms: f64) -> Option<&TelemetryFrame> {
    tel.get((t_ms.max(0.0) * TELEMETRY_HZ / 1000.0).round() as usize)
}

fn voice_at(ctx: &ClipContext, t_ms: f64) -> bool {
    ctx.voice_active
        .and_then(|v| v.get((t_ms.max(0.0) / HOP_MS) as usize).copied())
        .unwrap_or(false)
}

fn max_abs_lean(tel: &[TelemetryFrame], from_ms: f64, to_ms: f64) -> f64 {
    let lo = (from_ms * TELEMETRY_HZ / 1000.0).max(0.0) as usize;
    let hi = ((to_ms * TELEMETRY_HZ / 1000.0) as usize).min(tel.len());
    tel.get(lo..hi).map_or(0.0, |s| s.iter().map(|f| f.lean_angle.abs()).fold(0.0, f64::max))
}

/// Ranks every 12..25 s window by mean (Action Score + up to 15 lean points), lightly
/// favoring longer windows, then greedy non-overlapping selection. Boundaries snap to the
/// quietest hop nearby so cuts never chop a pull or a crackle.
pub fn generate_smart_clips(ctx: &ClipContext) -> Vec<SmartClip> {
    let a = ctx.analysis;
    let n_sec = a.action_score.len();
    let combined: Vec<f64> = (0..n_sec)
        .map(|s| {
            let lean = max_abs_lean(ctx.telemetry, s as f64 * 1000.0, (s + 1) as f64 * 1000.0);
            let lean_term = ((lean - 25.0) / 20.0).clamp(0.0, 1.0);
            (f64::from(a.action_score[s]) + 15.0 * lean_term).min(100.0)
        })
        .collect();
    let mut pre = vec![0.0f64; n_sec + 1];
    for s in 0..n_sec {
        pre[s + 1] = pre[s] + combined[s];
    }

    let mut cands: Vec<(f64, f64, usize, usize)> = Vec::new(); // (quality, mean, start, len)
    for &len in CLIP_LENGTHS_S.iter().filter(|&&l| l <= n_sec) {
        for s in 0..=n_sec - len {
            let mean = (pre[s + len] - pre[s]) / len as f64;
            cands.push((mean * (0.85 + 0.15 * (len - 12) as f64 / 13.0), mean, s, len));
        }
    }
    if cands.is_empty() && n_sec >= 3 {
        cands.push((pre[n_sec] / n_sec as f64, pre[n_sec] / n_sec as f64, 0, n_sec));
    }
    cands.sort_by(|x, y| y.0.total_cmp(&x.0));

    let best = cands.first().map_or(0.0, |c| c.0);
    let mut picked: Vec<(f64, f64, f64)> = Vec::new(); // (start_ms, end_ms, score)
    for (q, mean, s, len) in cands {
        if picked.len() >= MAX_CLIPS || (picked.len() >= MIN_CLIPS && q < (0.45 * best).max(20.0)) {
            break;
        }
        let (start, end) = snap_bounds(a, s as f64 * 1000.0, (s + len) as f64 * 1000.0);
        if picked.iter().any(|&(ps, pe, _)| start < pe + 2_000.0 && end > ps - 2_000.0) {
            continue;
        }
        picked.push((start, end, mean));
    }

    let upshifts: Vec<f64> = a
        .events
        .iter()
        .filter(|e| e.kind == AudioEventKind::Upshift)
        .map(|e| e.timestamp_ms)
        .collect();

    picked
        .into_iter()
        .enumerate()
        .map(|(rank, (start_ms, end_ms, score))| {
            let h0 = (start_ms / HOP_MS) as usize;
            let h1 = ((end_ms / HOP_MS) as usize).min(a.rpm.len());
            let rpm_max = a.rpm.get(h0..h1).map_or(0.0, |r| r.iter().copied().fold(0.0, f32::max));
            let pops = a
                .events
                .iter()
                .filter(|e| e.kind == AudioEventKind::Pop && (start_ms..end_ms).contains(&e.timestamp_ms))
                .count();
            let lean = max_abs_lean(ctx.telemetry, start_ms, end_ms);
            let voice_hops = ctx.voice_active.and_then(|v| v.get(h0..h1.min(v.len()))).map_or(0, |v| v.iter().filter(|x| **x).count());

            let mut tags = Vec::new();
            if rpm_max >= 9_000.0 {
                tags.push(ClipTag::RpmPeak);
            }
            if pops >= 3 {
                tags.push(ClipTag::PopsBangs);
            }
            if lean >= LEAN_TAG_DEG {
                tags.push(ClipTag::MaxLean);
            }
            if voice_hops >= HOPS_PER_SEC {
                tags.push(ClipTag::Voice);
            }
            let label = if pops >= 8 && rpm_max < 9_000.0 {
                "Pops & bangs".to_owned()
            } else if rpm_max >= 8_500.0 {
                format!("{} rpm pull", group_thousands(((rpm_max / 100.0).round() * 100.0) as u32))
            } else if lean >= LEAN_TAG_DEG {
                format!("{}° corner", lean.round() as u32)
            } else if pops >= 3 {
                "Pops & bangs".to_owned()
            } else {
                "Cruise".to_owned()
            };
            SmartClip {
                id: format!("clip-{:02}-{}", rank + 1, start_ms as u64),
                start_ms,
                end_ms,
                score: (score * 10.0).round() / 10.0,
                label,
                tags,
                camera_keyframes: auto_camera(ctx, start_ms, end_ms, &upshifts),
            }
        })
        .collect()
}

fn group_thousands(n: u32) -> String {
    if n >= 1_000 { format!("{},{:03}", n / 1_000, n % 1_000) } else { n.to_string() }
}

fn snap_bounds(a: &ExhaustAnalysis, start: f64, end: f64) -> (f64, f64) {
    let quietest = |from: f64, to: f64, fallback: f64| {
        let lo = (from.max(0.0) / HOP_MS) as usize;
        let hi = ((to / HOP_MS) as usize).min(a.level_db.len());
        a.level_db
            .get(lo..hi)
            .and_then(|s| s.iter().enumerate().min_by(|x, y| x.1.total_cmp(y.1)))
            .map_or(fallback, |(i, _)| (lo + i) as f64 * HOP_MS)
    };
    let s = quietest(start - 1_000.0, start + 500.0, start);
    let e = quietest(end - 500.0, end + 1_000.0, end).min(a.duration_ms);
    let e = e.clamp(s + 12_000.0, s + 25_000.0).min(a.duration_ms);
    (s, e)
}

/// FRONT by default and on hard braking / acceleration (|g_lon| > 0.45 g);
/// REAR while the rider speaks, at >= 35° lean, and for 600 ms after a quickshift.
/// A change must persist 300 ms and shots last at least 2 s.
fn auto_camera(ctx: &ClipContext, start_ms: f64, end_ms: f64, upshifts: &[f64]) -> Vec<CameraKeyframe> {
    const STEP: f64 = 100.0;
    let desired = |t: f64| {
        let f = frame_at(ctx.telemetry, t);
        let g_lon = f.map_or(0.0, |f| f.g_lon);
        let lean = f.map_or(0.0, |f| f.lean_angle.abs());
        if voice_at(ctx, t) {
            CameraAngle::Rear
        } else if g_lon < -0.45 {
            CameraAngle::Front
        } else if lean >= LEAN_TAG_DEG || upshifts.iter().any(|u| (t - 600.0..=t).contains(u)) {
            CameraAngle::Rear
        } else {
            CameraAngle::Front
        }
    };
    let mut current = desired(start_ms);
    let mut keys = vec![CameraKeyframe { timestamp_ms: start_ms, angle: current }];
    let mut shot_start = start_ms;
    let mut pending: Option<f64> = None;
    let mut t = start_ms + STEP;
    while t < end_ms {
        if desired(t) == current {
            pending = None;
        } else {
            let since = *pending.get_or_insert(t);
            if t - since >= 300.0 && since - shot_start >= 2_000.0 && end_ms - since >= 2_000.0 {
                current = desired(t);
                keys.push(CameraKeyframe { timestamp_ms: since, angle: current });
                shot_start = since;
                pending = None;
            }
        }
        t += STEP;
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic CP3: firing harmonics at RPM/40, a pull 6,500 -> 9,500 RPM, a quickshift at
    /// 3 s (60 ms ignition cut, -25 % RPM), then a second pull, plus broadband noise.
    fn synth_pull() -> (Vec<f32>, impl Fn(f64) -> f64) {
        let rpm_at = |t: f64| if t < 3.0 { 6_500.0 + 1_000.0 * t } else { 7_125.0 + 650.0 * (t - 3.0) };
        let n = (6.0 * SR as f64) as usize;
        let mut phase = 0.0f64;
        let mut seed = 0x2545_f491_u32;
        let x = (0..n)
            .map(|i| {
                let t = i as f64 / SR as f64;
                phase += std::f64::consts::TAU * rpm_at(t) / 40.0 / SR as f64;
                let tone: f64 = (1..=5).map(|k| (k as f64 * phase).sin() / k as f64).sum();
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let noise = (seed as f64 / u32::MAX as f64 - 0.5) * 0.05;
                let gate = if (3.0..3.06).contains(&t) { 0.05 } else { 1.0 };
                (0.3 * tone * gate + noise) as f32
            })
            .collect();
        (x, rpm_at)
    }

    #[test]
    fn tracks_cp3_rpm_and_detects_quickshift() {
        let (x, rpm_at) = synth_pull();
        let a = analyze_exhaust(&x);
        let mut errs: Vec<f64> = (10..110)
            .filter(|t| !(55..65).contains(t))
            .map(|t| {
                let truth = rpm_at((t as f64 + 0.5) * HOP_MS / 1000.0);
                (f64::from(a.rpm[t]) - truth).abs() / truth
            })
            .collect();
        errs.sort_by(f64::total_cmp);
        let median = errs[errs.len() / 2];
        assert!(median < 0.02, "median RPM error {median:.3}");
        let shift = a.events.iter().find(|e| e.kind == AudioEventKind::Upshift).expect("upshift");
        assert!((shift.timestamp_ms - 3_000.0).abs() < 150.0, "upshift at {}", shift.timestamp_ms);
        // The top of the pull / the shift is the best second.
        let best = a.action_score.iter().enumerate().max_by(|x, y| x.1.total_cmp(y.1)).map(|(i, _)| i);
        assert!(matches!(best, Some(2 | 3)), "scores {:?}", a.action_score);
    }
}
