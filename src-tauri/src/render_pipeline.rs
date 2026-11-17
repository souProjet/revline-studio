//! FFmpeg render: dual-fisheye `.insv` -> v360 rectilinear view (any size and rate) with Horizon Lock and
//! Front/Rear switching, Moody Asphalt LUT + vignette, HUD overlay piped as PNG frames from
//! the React exporter, Dominator GP3 mastering with voice ducking, two-pass loudnorm, and
//! hardware encoding (NVENC on Linux, VideoToolbox on macOS).
//!
//! Horizon Lock cost: v360 rebuilds its whole remap table on every command, so per-frame
//! roll through v360 caps throughput. v360 composes Y·P·R with roll applied first in output
//! space, so roll is an exact 2D rotation of the output: v360 renders a static square view
//! large enough for any rotation, and `rotate` (cheap to retarget) applies roll per frame.
//! Pitch is not a 2D shift at a 112° vertical FOV, so it still goes through v360, only when
//! it moves by >= 1°.

use std::{
    collections::VecDeque,
    ffi::OsString,
    fmt::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

use crate::{
    plates,
    telemetry::{v360_ypr, view_matrix},
    types::{AudioMode, CameraAngle, ProjectSource, SmartClip, TelemetryFrame, TELEMETRY_HZ},
};


#[cfg(target_os = "macos")]
pub const HWACCEL: &str = "videotoolbox";
#[cfg(not(target_os = "macos"))]
pub const HWACCEL: &str = "cuda";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CameraMode {
    Front,
    Rear,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VideoCodec {
    H264,
    Hevc,
    Av1,
}

impl VideoCodec {
    /// ffmpeg encoder name on this platform, if the platform has one.
    pub fn encoder(self) -> Option<&'static str> {
        #[cfg(target_os = "macos")]
        return match self {
            Self::H264 => Some("h264_videotoolbox"),
            Self::Hevc => Some("hevc_videotoolbox"),
            Self::Av1 => None,
        };
        #[cfg(not(target_os = "macos"))]
        return Some(match self {
            Self::H264 => "h264_nvenc",
            Self::Hevc => "hevc_nvenc",
            Self::Av1 => "av1_nvenc",
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundSettings {
    /// Dominator GP3 EQ on the exhaust: high-pass, body boost, rasp cut.
    pub exhaust_eq: bool,
    pub highpass_hz: f64,
    pub body_hz: f64,
    pub body_gain_db: f64,
    pub rasp_hz: f64,
    pub rasp_gain_db: f64,
    pub exhaust_gain_db: f64,
    pub voice_gain_db: f64,
    /// `afftdn` noise reduction in dB, 0 = off. Ignored when a model is set.
    pub voice_denoise_db: f64,
    /// RNNoise model for `arnndn` (ffmpeg ships none; see GregorR/rnnoise-models).
    pub voice_denoise_model: Option<PathBuf>,
    pub ducking: bool,
    /// Exhaust reduction while the rider speaks, dB.
    pub ducking_db: f64,
    pub loudness_lufs: f64,
    pub true_peak_db: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Quality {
    Standard,
    High,
    Max,
}

/// Target bitrate from pixel rate: bits per pixel per frame, lower for HEVC and AV1, which
/// reach the same quality with about 30 % fewer bits. Mirrored in `src/lib/settings.ts`.
pub fn bitrate_mbps(width: u32, height: u32, fps: u32, quality: Quality, codec: VideoCodec) -> u32 {
    let bpp = match quality {
        Quality::Standard => 0.10,
        Quality::High => 0.16,
        Quality::Max => 0.25,
    } * if codec == VideoCodec::H264 { 1.0 } else { 0.7 };
    let mbps = f64::from(width) * f64::from(height) * f64::from(fps) * bpp / 1e6;
    (mbps.round() as u32).clamp(4, 150)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlurWhen {
    Off,
    AboveLimit,
    Always,
}

/// A fixed spot in one lens image, such as the bike's dashboard when the camera is mounted on
/// the bike: it stays put in the fisheye image whatever the view does.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LensSpot {
    pub lens: CameraAngle,
    /// Center, 0..1 across and down the lens image.
    pub u: f64,
    pub v: f64,
    /// Half-size, fraction of the lens image width.
    pub radius: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacySettings {
    /// GPS speed above which the speed readout is hidden and the dashboard can be blurred.
    pub speed_limit_kmh: f64,
    /// Hide the HUD speed above the limit (drawn by the frontend).
    pub hide_hud_speed: bool,
    pub dashboard: BlurWhen,
    pub dashboard_spot: Option<LensSpot>,
    pub plates: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderSettings {
    pub camera_mode: CameraMode,
    pub horizon_lock: bool,
    /// Rolling-mean half-width at 60 Hz for Horizon Lock (0 = raw gyro, 12 ≈ 400 ms).
    pub horizon_stabilize: u8,
    /// `.cube` 3D LUT (Flat profile -> Moody Asphalt).
    pub lut_path: Option<PathBuf>,
    /// 0..1, 0.5 = `vignette=PI/4`.
    pub vignette: f64,
    pub hud: bool,
    pub codec: VideoCodec,
    pub quality: Quality,
    /// Output frame size, both even; the aspect (9:16, 4:5, 1:1, 16:9) follows from it.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub hwaccel_decode: bool,
    /// Per-lens field of view of the X4 fisheyes; tune if seams misalign.
    pub lens_fov_deg: f64,
    /// Field of view across the short side of the frame, so every aspect keeps the same zoom.
    pub h_fov_deg: f64,
    /// Added to gyro roll before Horizon Lock.
    pub roll_offset_deg: f64,
    /// Constant view tilt, negative = look down at the road.
    pub pitch_offset_deg: f64,
    /// Added to telemetry lean on the HUD.
    pub lean_offset_deg: f64,
    pub sound: SoundSettings,
    pub privacy: PrivacySettings,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderJob {
    pub source: ProjectSource,
    pub clip: SmartClip,
    pub output_path: PathBuf,
    pub settings: RenderSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FisheyeLayout {
    /// One 2:1 stream, front lens left half.
    SideBySide,
    /// Two square streams (one per lens), stacked with hstack. Stream 0 = front lens.
    DualStream,
}

struct Probe {
    layout: FisheyeLayout,
    /// Side of one square lens image, px.
    lens_px: u32,
    audio_channels: u32,
}

async fn ffprobe(path: &Path) -> Result<Probe> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "stream=codec_type,width,height,channels", "-of", "json"])
        .arg(path)
        .kill_on_drop(true)
        .output()
        .await
        .context("ffprobe is not installed or not on PATH")?;
    if !out.status.success() {
        bail!("ffprobe could not read {}: {}", path.display(), String::from_utf8_lossy(&out.stderr).trim());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let videos: Vec<(u64, u64)> = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .filter_map(|s| Some((s["width"].as_u64()?, s["height"].as_u64()?)))
        .filter(|(w, _)| *w >= 1_000) // skip thumbnails / preview tracks
        .collect();
    let (layout, lens_px) = match videos.as_slice() {
        [(w0, h0), (w1, h1), ..] if w0 == h0 && w0 == w1 && h0 == h1 => (FisheyeLayout::DualStream, *w0 as u32),
        [(w, h), ..] if *w == 2 * *h => (FisheyeLayout::SideBySide, *h as u32),
        other => bail!("unsupported .insv video layout {other:?} (expected dual fisheye)"),
    };
    let audio_channels = streams
        .iter()
        .find(|s| s["codec_type"] == "audio")
        .and_then(|s| s["channels"].as_u64())
        .context("the .insv has no audio stream")? as u32;
    Ok(Probe { layout, lens_px, audio_channels })
}

/// Filtergraph option values are single-quoted; reject the characters that would need
/// two-level escaping rather than guess at it.
fn quoted(p: &Path) -> Result<String> {
    let s = p.to_string_lossy();
    if s.contains('\'') || s.contains('\\') {
        bail!("path {s} contains a quote or backslash, which ffmpeg filtergraphs can't take");
    }
    Ok(format!("'{s}'"))
}

fn angle_at(clip: &SmartClip, mode: CameraMode, t_ms: f64) -> CameraAngle {
    match mode {
        CameraMode::Front => CameraAngle::Front,
        CameraMode::Rear => CameraAngle::Rear,
        CameraMode::Auto => clip
            .camera_keyframes
            .iter()
            .take_while(|k| k.timestamp_ms <= t_ms)
            .last()
            .map_or(CameraAngle::Front, |k| k.angle),
    }
}

/// v360 yaw/pitch/roll for absolute source time `t_ms`.
fn view_ypr(job: &RenderJob, telemetry: &[TelemetryFrame], t_ms: f64) -> (f64, f64, f64) {
    let s = &job.settings;
    let half = s.horizon_stabilize as usize;
    let (mut roll, pitch) = crate::telemetry::horizon_at(telemetry, t_ms, half);
    roll += s.roll_offset_deg;
    let rear = angle_at(&job.clip, s.camera_mode, t_ms) == CameraAngle::Rear;
    let m = view_matrix(roll, pitch, rear, s.horizon_lock);
    // Constant tilt in view space: M · Rx(offset).
    let (sn, cs) = s.pitch_offset_deg.to_radians().sin_cos();
    let mut t = [[0.0; 3]; 3];
    for (r, row) in m.iter().enumerate() {
        t[r] = [row[0], row[1] * cs + row[2] * sn, -row[1] * sn + row[2] * cs];
    }
    v360_ypr(&t)
}

/// Clip-relative seconds where GPS speed exceeds `limit_kmh`, padded by half a second and
/// with gaps under a second merged, so the blur never flickers on and off.
fn speeding_spans(telemetry: &[TelemetryFrame], start_ms: f64, dur_s: f64, limit_kmh: f64) -> Vec<(f64, f64)> {
    const PAD: f64 = 0.5;
    let mut spans: Vec<(f64, f64)> = Vec::new();
    let first = (start_ms * TELEMETRY_HZ / 1000.0).floor().max(0.0) as usize;
    let last = ((start_ms + dur_s * 1000.0) * TELEMETRY_HZ / 1000.0).ceil() as usize;
    for f in telemetry.iter().take(last + 1).skip(first) {
        if f.speed_kmh <= limit_kmh {
            continue;
        }
        let t = (f.timestamp_ms - start_ms) / 1000.0;
        let (a, b) = ((t - PAD).max(0.0), (t + PAD).min(dur_s));
        match spans.last_mut() {
            Some(last) if a - last.1 < 1.0 => last.1 = b,
            _ => spans.push((a, b)),
        }
    }
    spans
}

/// Blurs a fixed spot of the dual-fisheye input, before reprojection, from `[dfin]` to the
/// chain's continuation. `None` when there is nothing to blur in this clip.
fn lens_blur(spot: &LensSpot, lens_px: u32, spans: Option<&[(f64, f64)]>) -> Option<String> {
    let enable = match spans {
        Some([]) => return None,
        Some(sp) => {
            let terms: Vec<String> = sp.iter().map(|(a, b)| format!("between(t,{a:.3},{b:.3})")).collect();
            format!(":enable='{}'", terms.join("+"))
        }
        None => String::new(),
    };
    let lens = f64::from(lens_px);
    let x0 = if spot.lens == CameraAngle::Rear { lens } else { 0.0 };
    let half = (spot.radius.clamp(0.01, 0.25) * lens).max(8.0);
    let even = |v: f64| ((v / 2.0).floor() * 2.0).max(0.0) as u32;
    let size = even(2.0 * half).max(16);
    let x = even((x0 + spot.u.clamp(0.0, 1.0) * lens - half).clamp(x0, x0 + lens - f64::from(size)));
    let y = even((spot.v.clamp(0.0, 1.0) * lens - half).clamp(0.0, lens - f64::from(size)));
    let r = (size / 5).clamp(4, 120);
    Some(format!(
        "[dfin]split[dfa][dfb];[dfb]crop={size}:{size}:{x}:{y},boxblur=lr={r}:lp=3:cr={cr}:cp=3[dfbl];[dfa][dfbl]overlay={x}:{y}{enable}",
        cr = (r / 2).max(2),
    ))
}

fn wrap_deg(d: f64) -> f64 {
    let d = d % 360.0;
    if d > 180.0 { d - 360.0 } else if d < -180.0 { d + 360.0 } else { d }
}

/// sendcmd script: yaw cuts and >= 1° pitch moves to v360, roll to `rotate` every frame it
/// moves by >= 0.05°.
fn camera_script(job: &RenderJob, telemetry: &[TelemetryFrame], frames: usize, fps: f64) -> ((f64, f64, f64), String) {
    let start = job.clip.start_ms;
    let first = view_ypr(job, telemetry, start);
    let (mut yaw, mut pitch, mut roll) = first;
    let mut script = String::new();
    for i in 1..frames {
        let t_rel = i as f64 / fps;
        let (y, p, r) = view_ypr(job, telemetry, start + t_rel * 1000.0);
        let mut cmds = Vec::with_capacity(3);
        if wrap_deg(y - yaw).abs() >= 1.0 {
            cmds.push(format!("v360@cam yaw {y:.3}"));
            yaw = y;
        }
        if (p - pitch).abs() >= 1.0 {
            cmds.push(format!("v360@cam pitch {p:.3}"));
            pitch = p;
        }
        if wrap_deg(r - roll).abs() >= 0.05 {
            cmds.push(format!("rotate@roll angle {:.6}", -r.to_radians()));
            roll = r;
        }
        if !cmds.is_empty() {
            let _ = writeln!(script, "{t_rel:.4} {};", cmds.join(","));
        }
    }
    (first, script)
}

struct AudioInputs {
    exhaust_channels: u32,
    mode: AudioMode,
    /// ffmpeg input index of the external voice file, if used.
    voice_input: Option<usize>,
    /// Silence to prepend when the phone started after the clip start.
    voice_delay_ms: f64,
    drift_ppm: f64,
}

/// Exhaust + optional voice -> `[aout]`. `loudnorm` is the final filter's arguments.
fn audio_graph(a: &AudioInputs, s: &SoundSettings, loudnorm: &str) -> Result<String> {
    let mut g = String::new();
    let mut exhaust = format!("volume={:.2}dB", s.exhaust_gain_db);
    if s.exhaust_eq {
        let _ = write!(
            exhaust,
            ",highpass=f={:.0}:poles=2,equalizer=f={:.0}:t=q:w=0.9:g={:.2},equalizer=f={:.0}:t=q:w=1.4:g={:.2}",
            s.highpass_hz, s.body_hz, s.body_gain_db, s.rasp_hz, s.rasp_gain_db
        );
    }
    let downmix = if a.exhaust_channels >= 2 { "[0:a:0]pan=mono|c0=0.5*c0+0.5*c1[exraw];" } else { "[0:a:0]anull[exraw];" };
    let voice_src = match (a.mode, a.voice_input) {
        (AudioMode::StereoSplit, _) if a.exhaust_channels >= 2 => {
            g.push_str("[0:a:0]channelsplit=channel_layout=stereo[exraw][vraw];");
            true
        }
        (AudioMode::ExternalVoice, Some(idx)) => {
            let rate = 1.0 + a.drift_ppm * 1e-6;
            let delay = a.voice_delay_ms.max(0.0).round() as u64;
            let _ = write!(g, "[{idx}:a:0]aformat=channel_layouts=mono,aresample=48000,atempo={rate:.8},adelay={delay}:all=1[vraw];");
            g.push_str(downmix);
            true
        }
        _ => {
            g.push_str(downmix);
            false
        }
    };
    let _ = write!(g, "[exraw]aresample=48000,{exhaust}[ex];");

    let tail = format!("{loudnorm},aresample=48000,aformat=channel_layouts=stereo[aout]");
    if voice_src {
        let denoise = match (&s.voice_denoise_model, s.voice_denoise_db) {
            (Some(m), _) => format!("arnndn=m={}", quoted(m)?),
            (None, nr) if nr > 0.0 => format!("afftdn=nr={:.0}:nf=-35:tn=1", nr.clamp(1.0, 97.0)),
            _ => "anull".to_owned(),
        };
        let _ = write!(
            g,
            "[vraw]aresample=48000,highpass=f=110,lowpass=f=7500,{denoise},\
             agate=threshold=0.02:ratio=3:attack=5:release=250,volume={:.2}dB,asplit=2[vsc][vmix];",
            s.voice_gain_db
        );
        if s.ducking && s.ducking_db > 0.0 {
            // GR = (L - T)(1 - 1/ratio). Speech at ~-22 dBFS over T = -36.5 dBFS leaves 14.5 dB
            // above threshold, so ratio = 1 / (1 - depth / 14.5) gives the requested depth.
            let ratio = 1.0 / (1.0 - (s.ducking_db.min(12.0) / 14.5));
            let _ = write!(g, "[ex][vsc]sidechaincompress=threshold=0.015:ratio={ratio:.3}:knee=4:attack=40:release=400:detection=rms[duck];");
        } else {
            g.push_str("[vsc]anullsink;[ex]anull[duck];");
        }
        let _ = write!(g, "[duck][vmix]amix=inputs=2:duration=first:normalize=0,{tail}");
    } else {
        let _ = write!(g, "[ex]{tail}");
    }
    Ok(g)
}

fn loudnorm_target(s: &SoundSettings) -> String {
    format!("loudnorm=I={:.1}:TP={:.1}:LRA=11", s.loudness_lufs.clamp(-30.0, -5.0), s.true_peak_db.clamp(-9.0, 0.0))
}

/// Pass 1 of loudnorm on the mastered mix; returns the linear pass-2 filter. Single-pass
/// loudnorm runs dynamically and pumps on throttle blips, which ruins a Pure Sound edit.
async fn measure_loudness(inputs: &[OsString], a: &AudioInputs, s: &SoundSettings) -> Result<String> {
    let target = loudnorm_target(s);
    let graph = audio_graph(a, s, &format!("{target}:print_format=json"))?;
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostdin"])
        .args(inputs)
        .arg("-filter_complex")
        .arg(graph)
        .args(["-map", "[aout]", "-f", "null", "-"])
        .kill_on_drop(true)
        .output()
        .await
        .context("ffmpeg is not installed or not on PATH")?;
    let log = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        bail!("loudness measurement failed: {}", tail(&log, 12));
    }
    let json = log.rfind('{').and_then(|i| log[i..].find('}').map(|j| &log[i..=i + j])).context("loudnorm printed no measurement")?;
    let m: serde_json::Value = serde_json::from_str(json)?;
    let f = |k: &str| m[k].as_str().map(str::to_owned).with_context(|| format!("loudnorm field {k} missing"));
    Ok(format!(
        "{target}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
        f("input_i")?, f("input_tp")?, f("input_lra")?, f("input_thresh")?, f("target_offset")?
    ))
}

fn tail(log: &str, n: usize) -> String {
    let lines: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn encoder_args(codec: VideoCodec, bitrate_mbps: u32) -> Result<Vec<String>> {
    let enc = codec.encoder().context("this codec has no hardware encoder on this platform")?;
    let b = bitrate_mbps.clamp(4, 150);
    let mut a: Vec<String> = vec!["-c:v".into(), enc.into()];
    #[cfg(not(target_os = "macos"))]
    a.extend(
        ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-spatial-aq", "1", "-temporal-aq", "1", "-rc-lookahead", "32"]
            .map(String::from),
    );
    #[cfg(target_os = "macos")]
    a.extend(["-realtime", "0"].map(String::from));
    a.extend(["-b:v".into(), format!("{b}M"), "-maxrate".into(), format!("{}M", b * 7 / 5), "-bufsize".into(), format!("{}M", b * 2), "-g".into(), "120".into()]);
    match codec {
        VideoCodec::H264 => a.extend(["-profile:v", "high"].map(String::from)),
        // hvc1 tag: what Apple players and TikTok's uploader expect for HEVC in MP4.
        VideoCodec::Hevc => a.extend(["-profile:v", "main", "-tag:v", "hvc1"].map(String::from)),
        VideoCodec::Av1 => {}
    }
    Ok(a)
}

/// Plate detection rate and the long side of the frames it looks at.
const DETECT_FPS: u32 = 10;
const DETECT_LONG_PX: u32 = 1280;

/// What the license-plate pass needs: the model on disk, a cancel flag, and a callback with
/// (frames looked at, total).
pub struct PlatePass {
    pub model: PathBuf,
    pub cancel: Arc<AtomicBool>,
    pub on_progress: Arc<dyn Fn(usize, usize) + Send + Sync>,
}

/// Runs ffmpeg with `args` (raw RGB frames of `w`x`h` on stdout) and the plate detector on
/// every frame. Returns (time in s, boxes in those frames' pixels) per frame.
async fn detect_plates(pass: &PlatePass, args: Vec<OsString>, w: u32, h: u32, total: usize) -> Result<Vec<(f64, Vec<plates::PlateBox>)>> {
    let (model, cancel, on_progress) = (pass.model.clone(), pass.cancel.clone(), pass.on_progress.clone());
    tokio::task::spawn_blocking(move || {
        use std::io::Read as _;
        let mut detector = plates::Detector::load(&model)?;
        let mut child = std::process::Command::new("ffmpeg")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("could not start ffmpeg; is it installed and on PATH?")?;
        let mut out = child.stdout.take().context("ffmpeg stdout")?;
        let mut frame = vec![0u8; w as usize * h as usize * 3];
        let mut dets = Vec::with_capacity(total);
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                bail!("canceled");
            }
            match out.read_exact(&mut frame) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e.into()),
            }
            let boxes = detector.detect(&frame, w as usize, h as usize)?;
            dets.push((dets.len() as f64 / f64::from(DETECT_FPS), boxes));
            on_progress(dets.len(), total);
        }
        let mut log = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut log);
        }
        if !child.wait()?.success() {
            bail!("plate detection pass failed: {}", tail(&log, 6));
        }
        Ok(dets)
    })
    .await?
}

/// Filter chain (appended to a video chain) that pixelates the boxes `plate_file` moves.
fn plate_blur(w: u32, h: u32, fps: u32, plate_file: &Path) -> Result<String> {
    let slots: Vec<String> = (0..plates::SLOTS).map(|n| format!("drawbox@p{n}=x=-64:y=-64:w=8:h=8:color=white:t=fill")).collect();
    Ok(format!(
        ",split[pva][pvb];[pvb]scale={pw}:{ph}:flags=area,scale={w}:{h}:flags=neighbor[pvp];\
         color=c=black:s={w}x{h}:r={fps},format=gray,sendcmd=f={pf},{slots}[pvm];\
         [pvp][pvm]alphamerge[pvpa];[pva][pvpa]overlay=0:0:shortest=1",
        pw = (w / 16).max(2),
        ph = (h / 16).max(2),
        pf = quoted(plate_file)?,
        slots = slots.join(","),
    ))
}

pub struct PreparedRender {
    pub args: Vec<OsString>,
    pub frame_count: usize,
    pub output_path: PathBuf,
    pub part_path: PathBuf,
    pub needs_hud_frames: bool,
}

/// Probes, writes the camera script into `work_dir`, runs the loudness pass, and returns the
/// final ffmpeg argument list. ffmpeg writes to `<output>.part` until it succeeds.
pub async fn prepare(job: &RenderJob, telemetry: &[TelemetryFrame], work_dir: &Path, plate_pass: Option<&PlatePass>) -> Result<PreparedRender> {
    let s = &job.settings;
    let src = &job.source;
    let dur_s = (job.clip.end_ms - job.clip.start_ms) / 1000.0;
    if !(1.0..=180.0).contains(&dur_s) {
        bail!("clip {} is {dur_s:.1} s long; renders take 1 to 180 s", job.clip.id);
    }
    if let Some(dir) = job.output_path.parent() {
        if !dir.is_dir() {
            bail!("the output folder {} does not exist", dir.display());
        }
    }
    let (w, h) = (s.width, s.height);
    if !(320..=3840).contains(&w) || !(320..=3840).contains(&h) || w % 2 != 0 || h % 2 != 0 {
        bail!("output size {w}x{h} must be even and 320 to 3840 px on each side");
    }
    if !(24..=60).contains(&s.fps) {
        bail!("frame rate {} must be 24 to 60 fps", s.fps);
    }
    let fps = f64::from(s.fps);
    let frames = (dur_s * fps).round() as usize;
    let encoder = encoder_args(s.codec, bitrate_mbps(w, h, s.fps, s.quality, s.codec))?;
    let probe = ffprobe(&src.insv_path).await?;

    tokio::fs::create_dir_all(work_dir).await?;
    let ((y0, p0, r0), script) = camera_script(job, telemetry, frames, fps);
    let cmd_file = work_dir.join(format!("{}.cmd", job.clip.id));
    tokio::fs::write(&cmd_file, script).await?;

    let ss = format!("{:.3}", job.clip.start_ms / 1000.0);
    let t = format!("{dur_s:.3}");
    let insv_in: Vec<OsString> = ["-ss", &ss, "-t", &t, "-i"].map(OsString::from).into_iter().chain([src.insv_path.clone().into_os_string()]).collect();

    let use_voice_file = src.audio_mode == AudioMode::ExternalVoice && src.external_audio_path.is_some();
    let rate = 1.0 + src.drift_ppm * 1e-6;
    let ext_start_ms = job.clip.start_ms * rate + src.sync_offset_ms;
    let voice_in: Vec<OsString> = match (&src.external_audio_path, use_voice_file) {
        (Some(p), true) => vec![
            "-ss".into(),
            format!("{:.3}", ext_start_ms.max(0.0) / 1000.0).into(),
            "-t".into(),
            format!("{:.3}", dur_s * rate).into(),
            "-i".into(),
            p.clone().into_os_string(),
        ],
        _ => Vec::new(),
    };
    let mut audio = AudioInputs {
        exhaust_channels: probe.audio_channels,
        mode: src.audio_mode,
        voice_input: use_voice_file.then_some(1),
        voice_delay_ms: -ext_start_ms,
        drift_ppm: src.drift_ppm,
    };
    let loud_inputs: Vec<OsString> = insv_in.iter().chain(&voice_in).cloned().collect();
    let loudnorm = measure_loudness(&loud_inputs, &audio, &s.sound).await?;

    let mut args: Vec<OsString> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"].map(OsString::from).to_vec();
    if s.hwaccel_decode {
        args.extend(["-hwaccel", HWACCEL].map(OsString::from));
    }
    args.extend(insv_in.iter().cloned());
    let hud_idx = if s.hud {
        args.extend(["-thread_queue_size", "1024", "-f", "image2pipe", "-framerate"].map(OsString::from));
        args.extend([s.fps.to_string().into(), OsString::from("-c:v"), "png".into(), "-i".into(), "pipe:0".into()]);
        Some(1)
    } else {
        None
    };
    if use_voice_file {
        audio.voice_input = Some(if hud_idx.is_some() { 2 } else { 1 });
        args.extend(voice_in);
    }

    let pv = &s.privacy;
    let dash = match (pv.dashboard, &pv.dashboard_spot) {
        (BlurWhen::Always, Some(spot)) => lens_blur(spot, probe.lens_px, None),
        (BlurWhen::AboveLimit, Some(spot)) => {
            lens_blur(spot, probe.lens_px, Some(&speeding_spans(telemetry, job.clip.start_ms, dur_s, pv.speed_limit_kmh)))
        }
        _ => None,
    };
    // The reframed, leveled view at any size and rate, from the source input to `rotate`.
    let view = |w: u32, h: u32, fps: u32| -> Result<String> {
        // Square canvas that still covers the output at any roll (its diagonal), with the
        // focal length the field of view gives across the short side.
        let canvas = (f64::from(w).hypot(f64::from(h)) / 2.0).ceil() as u32 * 2 + 4;
        let focal = f64::from(w.min(h)) / 2.0 / (s.h_fov_deg.clamp(40.0, 130.0).to_radians() / 2.0).tan();
        let canvas_fov = 2.0 * (f64::from(canvas) / 2.0 / focal).atan().to_degrees();
        let mut g = String::new();
        match probe.layout {
            FisheyeLayout::DualStream => g.push_str("[0:v:0][0:v:1]hstack=inputs=2,"),
            FisheyeLayout::SideBySide => g.push_str("[0:v:0]"),
        }
        let _ = write!(g, "setpts=PTS-STARTPTS,fps={fps}");
        if let Some(chain) = &dash {
            g.push_str("[dfin];");
            g.push_str(chain);
        }
        let _ = write!(
            g,
            ",sendcmd=f={cmd},\
             v360@cam=input=dfisheye:output=flat:ih_fov={lf}:iv_fov={lf}:h_fov={cf:.4}:v_fov={cf:.4}:\
             w={canvas}:h={canvas}:interp=cubic:rorder=ypr:yaw={y0:.3}:pitch={p0:.3}:roll=0,\
             rotate@roll=angle={a0:.6}:ow={w}:oh={h}:c=black",
            cmd = quoted(&cmd_file)?,
            lf = s.lens_fov_deg,
            cf = canvas_fov,
            a0 = -r0.to_radians(),
        );
        Ok(g)
    };
    let mut g = view(w, h, s.fps)?;

    if let (true, Some(pass)) = (pv.plates, plate_pass) {
        // Pass 1: the same view, smaller and at 10 fps, as raw frames for the detector.
        let k = (f64::from(DETECT_LONG_PX) / f64::from(w.max(h))).min(1.0);
        let even = |v: u32| ((f64::from(v) * k / 2.0).round() as u32 * 2).max(2);
        let (dw, dh) = (even(w), even(h));
        let total = (dur_s * f64::from(DETECT_FPS)).ceil() as usize;
        let mut det_args: Vec<OsString> = ["-hide_banner", "-nostdin", "-loglevel", "error"].map(OsString::from).to_vec();
        if s.hwaccel_decode {
            det_args.extend(["-hwaccel", HWACCEL].map(OsString::from));
        }
        det_args.extend(insv_in.iter().cloned());
        det_args.push("-filter_complex".into());
        det_args.push(format!("{},format=rgb24[det]", view(dw, dh, DETECT_FPS)?).into());
        det_args.extend(["-map", "[det]", "-frames:v", &total.to_string(), "-f", "rawvideo", "pipe:1"].map(OsString::from));
        let dets = detect_plates(pass, det_args, dw, dh, total).await?;

        // Pass 2: pixelate the whole view once, then show it only through a mask of boxes
        // that a sendcmd script moves over the plates.
        if let Some(script) = plates::mask_script(&dets, frames, fps, w as f32 / dw as f32, w, h) {
            let plate_file = work_dir.join(format!("{}.plates", job.clip.id));
            tokio::fs::write(&plate_file, script).await?;
            g.push_str(&plate_blur(w, h, s.fps, &plate_file)?);
        }
    }
    if let Some(lut) = &s.lut_path {
        let _ = write!(g, ",lut3d=file={}:interp=tetrahedral", quoted(lut)?);
    }
    if s.vignette > 0.0 {
        let _ = write!(g, ",vignette=angle={:.4}", s.vignette.clamp(0.0, 1.0) * std::f64::consts::FRAC_PI_2);
    }
    match hud_idx {
        Some(i) => {
            let _ = write!(g, "[base];[{i}:v]format=rgba,setpts=PTS-STARTPTS[hud];[base][hud]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[vout];");
        }
        None => g.push_str(",format=yuv420p[vout];"),
    }
    g.push_str(&audio_graph(&audio, &s.sound, &loudnorm)?);

    let part_path = PathBuf::from(format!("{}.part", job.output_path.display()));
    args.push("-filter_complex".into());
    args.push(g.into());
    args.extend(["-map", "[vout]", "-map", "[aout]"].map(OsString::from));
    args.extend(encoder.into_iter().map(OsString::from));
    args.extend(
        [
            "-r", &s.fps.to_string(),
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
            "-frames:v", &frames.to_string(),
            "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:2", "-nostats",
        ]
        .map(OsString::from),
    );
    args.push(part_path.clone().into_os_string());

    Ok(PreparedRender { args, frame_count: frames, output_path: job.output_path.clone(), part_path, needs_hud_frames: s.hud })
}

/// Parsed from ffmpeg `-progress` blocks.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct EncodeStats {
    pub frame: usize,
    pub fps: f64,
    /// Encode speed relative to real time (1.0 = 60 fps).
    pub speed: f64,
    pub size_bytes: u64,
}

/// A running ffmpeg. HUD PNG frames go to stdin in order; `finish` closes it and moves the
/// `.part` file into place only when ffmpeg exits cleanly.
pub struct RenderProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    log: Arc<Mutex<VecDeque<String>>>,
    pub output_path: PathBuf,
    part_path: PathBuf,
}

impl RenderProcess {
    pub fn spawn(p: PreparedRender, on_stats: impl Fn(EncodeStats) + Send + 'static) -> Result<Self> {
        let mut child = Command::new("ffmpeg")
            .args(&p.args)
            .stdin(if p.needs_hud_frames { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("ffmpeg is not installed or not on PATH")?;
        let stdin = child.stdin.take();
        let stderr = child.stderr.take().context("ffmpeg stderr not captured")?;
        let log = Arc::new(Mutex::new(VecDeque::with_capacity(40)));
        let log_w = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut stats = EncodeStats::default();
            while let Ok(Some(line)) = lines.next_line().await {
                match line.split_once('=') {
                    Some((k, v)) if !k.contains(' ') => {
                        let v = v.trim();
                        match k {
                            "frame" => stats.frame = v.parse().unwrap_or(stats.frame),
                            "fps" => stats.fps = v.parse().unwrap_or(stats.fps),
                            "speed" => stats.speed = v.trim_end_matches('x').parse().unwrap_or(stats.speed),
                            "total_size" => stats.size_bytes = v.parse().unwrap_or(stats.size_bytes),
                            "progress" => on_stats(stats),
                            _ => {}
                        }
                    }
                    _ => {
                        let mut l = log_w.lock().await;
                        if l.len() == 40 {
                            l.pop_front();
                        }
                        l.push_back(line);
                    }
                }
            }
        });
        Ok(Self { child, stdin, log, output_path: p.output_path, part_path: p.part_path })
    }

    pub async fn push_hud_frame(&mut self, png: &[u8]) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let stdin = self.stdin.as_mut().context("this render takes no HUD frames")?;
        if let Err(e) = stdin.write_all(png).await {
            bail!("ffmpeg stopped reading HUD frames ({e}): {}", self.log_tail().await);
        }
        Ok(())
    }

    pub async fn finish(mut self) -> Result<PathBuf> {
        drop(self.stdin.take());
        let status = self.child.wait().await?;
        if !status.success() {
            let _ = tokio::fs::remove_file(&self.part_path).await;
            bail!("ffmpeg exited with {status}: {}", self.log_tail().await);
        }
        tokio::fs::rename(&self.part_path, &self.output_path)
            .await
            .with_context(|| format!("could not move the render to {}", self.output_path.display()))?;
        Ok(self.output_path)
    }

    pub async fn cancel(mut self) {
        let _ = self.child.kill().await;
        let _ = tokio::fs::remove_file(&self.part_path).await;
    }

    async fn log_tail(&self) -> String {
        let l = self.log.lock().await;
        let n = l.len().saturating_sub(12);
        l.iter().skip(n).cloned().collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CameraKeyframe, ClipTag};

    pub fn default_sound() -> SoundSettings {
        SoundSettings {
            exhaust_eq: true, highpass_hz: 65.0, body_hz: 120.0, body_gain_db: 2.0, rasp_hz: 3_500.0, rasp_gain_db: -2.5,
            exhaust_gain_db: 0.0, voice_gain_db: 0.0, voice_denoise_db: 18.0, voice_denoise_model: None,
            ducking: true, ducking_db: 5.0, loudness_lufs: -14.0, true_peak_db: -1.0,
        }
    }

    #[test]
    fn speeding_spans_pad_and_merge() {
        let frame = |i: usize, kmh: f64| TelemetryFrame {
            timestamp_ms: i as f64 * 1000.0 / 60.0, lean_angle: 0.0, horizon_roll: 0.0, horizon_pitch: 0.0,
            g_lon: 0.0, g_lat: 0.0, speed_kmh: kmh, lat: 0.0, lon: 0.0, audio_rms: 0.0, spectrum_bars: [0.0; 24],
        };
        // Fast 1..2 s and 2.6..3 s (gap under a second: merged), then 6..7 s.
        let tel: Vec<_> = (0..600)
            .map(|i| {
                let t = i as f64 / 60.0;
                frame(i, if (1.0..2.0).contains(&t) || (2.6..3.0).contains(&t) || (6.0..7.0).contains(&t) { 130.0 } else { 80.0 })
            })
            .collect();
        let spans = speeding_spans(&tel, 0.0, 9.0, 110.0);
        assert_eq!(spans.len(), 2, "{spans:?}");
        assert!((spans[0].0 - 0.5).abs() < 0.05 && (spans[0].1 - 3.5).abs() < 0.05, "{spans:?}");
        assert!((spans[1].0 - 5.5).abs() < 0.05 && (spans[1].1 - 7.5).abs() < 0.05, "{spans:?}");
        assert!(speeding_spans(&tel, 0.0, 9.0, 200.0).is_empty());
    }

    /// End-to-end on a synthetic `.insv` stand-in (two 1440² streams + stereo audio): probe,
    /// sendcmd v360 + rotate Horizon Lock, Stereo Split ducking, two-pass loudnorm, platform
    /// hardware decode and encode (VideoToolbox on macOS, NVENC elsewhere).
    /// Detection then pixelation on a still with a plate. Needs ffmpeg, REVLINE_PLATE_MODEL and
    /// REVLINE_PLATE_IMAGE; writes the result to `$TMPDIR/revline-plates.png`.
    #[tokio::test]
    #[ignore]
    async fn pixelates_detected_plates() {
        let image = std::env::var("REVLINE_PLATE_IMAGE").unwrap();
        let src = |vf: &str| -> Vec<OsString> {
            ["-hide_banner", "-nostdin", "-loglevel", "error", "-loop", "1", "-t", "1", "-i", &image, "-filter_complex", vf].map(OsString::from).to_vec()
        };
        let pass = PlatePass {
            model: std::env::var("REVLINE_PLATE_MODEL").unwrap().into(),
            cancel: Arc::new(AtomicBool::new(false)),
            on_progress: Arc::new(|_, _| {}),
        };
        let mut args = src("[0:v]scale=640:360,setsar=1,fps=10,format=rgb24[det]");
        args.extend(["-map", "[det]", "-frames:v", "10", "-f", "rawvideo", "pipe:1"].map(OsString::from));
        let dets = detect_plates(&pass, args, 640, 360, 10).await.unwrap();
        assert_eq!(dets.len(), 10);
        let b = *dets[5].1.first().expect("a plate");
        let script = plates::mask_script(&dets, 30, 30.0, 2.0, 1280, 720).unwrap();
        let dir = std::env::temp_dir();
        let plate_file = dir.join("revline-plates.cmd");
        std::fs::write(&plate_file, script).unwrap();

        let frame = |vf: String| {
            let mut a = src(&vf);
            a.extend(["-map", "[out]", "-frames:v", "16", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"].map(OsString::from));
            let out = std::process::Command::new("ffmpeg").args(&a).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            out.stdout[out.stdout.len() - 1280 * 720 * 3..].to_vec()
        };
        let base = "[0:v]scale=1280:720,setsar=1,fps=30".to_string();
        let plain = frame(format!("{base}[out]"));
        let blurred = frame(format!("{base}{}[out]", plate_blur(1280, 720, 30, &plate_file).unwrap()));
        // Mean absolute difference inside the plate and in a corner far from it.
        let diff = |x0: f32, y0: f32, x1: f32, y1: f32| {
            let (mut sum, mut n) = (0u64, 0u64);
            for y in y0 as usize..y1 as usize {
                for x in x0 as usize..x1 as usize {
                    for c in 0..3 {
                        let i = (y * 1280 + x) * 3 + c;
                        sum += u64::from(plain[i].abs_diff(blurred[i]));
                        n += 1;
                    }
                }
            }
            sum as f64 / n as f64
        };
        let inside = diff(b.x0 * 2.0, b.y0 * 2.0, b.x1 * 2.0, b.y1 * 2.0);
        let corner = if b.x0 > 320.0 { diff(0.0, 0.0, 200.0, 120.0) } else { diff(1080.0, 600.0, 1280.0, 720.0) };
        let png = dir.join("revline-plates.png");
        let mut a = src(&format!("{base}{}[out]", plate_blur(1280, 720, 30, &plate_file).unwrap()));
        a.extend(["-map", "[out]", "-ss", "0.5", "-frames:v", "1", "-y"].map(OsString::from));
        a.push(png.into_os_string());
        assert!(std::process::Command::new("ffmpeg").args(&a).status().unwrap().success());
        eprintln!("plate {b:?}: inside {inside:.1}, corner {corner:.1}");
        assert!(inside > 8.0 && corner < 2.0, "inside {inside}, corner {corner}");
    }

    /// `cargo test -- --ignored`, needs ffmpeg.
    #[tokio::test]
    #[ignore]
    async fn renders_synthetic_dual_fisheye() {
        let dir = std::env::temp_dir().join("revline-render-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("VID_test.mp4");
        let ok = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=s=1440x1440:r=60:d=4",
                "-f", "lavfi", "-i", "smptebars=s=1440x1440:r=60:d=4",
                "-f", "lavfi", "-i", "sine=f=220:d=4:sample_rate=48000",
                "-f", "lavfi", "-i", "sine=f=900:d=4:sample_rate=48000",
                "-filter_complex", "[2:a][3:a]join=inputs=2:channel_layout=stereo[a]",
                "-map", "0:v", "-map", "1:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(ok.success());

        let telemetry: Vec<TelemetryFrame> = (0..240)
            .map(|i| TelemetryFrame {
                timestamp_ms: i as f64 * 1000.0 / 60.0,
                lean_angle: 40.0 * (i as f64 / 60.0).sin(),
                horizon_roll: 40.0 * (i as f64 / 60.0).sin(),
                horizon_pitch: 3.0 * (i as f64 / 30.0).sin(),
                g_lon: 0.0, g_lat: 0.0, speed_kmh: if (60..150).contains(&i) { 120.0 } else { 50.0 }, lat: 0.0, lon: 0.0,
                audio_rms: 0.0, spectrum_bars: [0.0; 24],
            })
            .collect();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let pass = std::env::var("REVLINE_PLATE_MODEL").ok().map(|model| {
            let seen = seen.clone();
            PlatePass { model: model.into(), cancel: Arc::new(AtomicBool::new(false)), on_progress: Arc::new(move |done, _| seen.store(done, Ordering::Relaxed)) }
        });
        for (w, h, fps) in [(1080, 1920, 60), (1280, 720, 30)] {
            let job = RenderJob {
                source: ProjectSource {
                    insv_path: src.clone(), lrv_path: None, external_audio_path: None,
                    audio_mode: AudioMode::StereoSplit, sync_offset_ms: 0.0, drift_ppm: 0.0,
                },
                clip: SmartClip {
                    id: "t".into(), start_ms: 500.0, end_ms: 3_500.0, score: 50.0, label: "T".into(),
                    tags: vec![ClipTag::Voice],
                    camera_keyframes: vec![
                        CameraKeyframe { timestamp_ms: 500.0, angle: CameraAngle::Front },
                        CameraKeyframe { timestamp_ms: 2_000.0, angle: CameraAngle::Rear },
                    ],
                },
                output_path: dir.join(format!("out-{w}x{h}.mp4")),
                settings: RenderSettings {
                    camera_mode: CameraMode::Auto,
                    horizon_lock: true,
                    horizon_stabilize: 12,
                    lut_path: None,
                    vignette: 0.5,
                    hud: false, codec: VideoCodec::H264, quality: Quality::High, width: w, height: h, fps, hwaccel_decode: true,
                    lens_fov_deg: 200.0,
                    h_fov_deg: 80.0,
                    roll_offset_deg: 0.0,
                    pitch_offset_deg: -8.0,
                    lean_offset_deg: 0.0,
                    sound: default_sound(),
                privacy: PrivacySettings {
                    speed_limit_kmh: 90.0, hide_hud_speed: true,
                    // With REVLINE_PLATE_MODEL set, runs the detection pass (finds nothing here).
                    plates: pass.is_some(),
                    // Exercises the fisheye-space blur on both renders.
                    dashboard: if fps == 60 { BlurWhen::Always } else { BlurWhen::AboveLimit },
                    dashboard_spot: Some(LensSpot { lens: CameraAngle::Rear, u: 0.5, v: 0.8, radius: 0.08 }),
                },
                },
            };
            let p = prepare(&job, &telemetry, &dir, pass.as_ref()).await.unwrap();
            if pass.is_some() {
                assert!(seen.swap(0, Ordering::Relaxed) > 0, "the detection pass ran");
            }
            let last = Arc::new(std::sync::Mutex::new(EncodeStats::default()));
            let l2 = last.clone();
            let out = RenderProcess::spawn(p, move |s| *l2.lock().unwrap() = s).unwrap().finish().await.unwrap();
            assert!(!PathBuf::from(format!("{}.part", out.display())).exists());
            let frames = 3 * fps;
            assert_eq!(last.lock().unwrap().frame, frames as usize);
            let probe = std::process::Command::new("ffprobe")
                .args(["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0"])
                .arg(&out)
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), format!("{w},{h},{frames}"));
        }
    }
}
