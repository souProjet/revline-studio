//! FFmpeg render: dual-fisheye `.insv` -> v360 rectilinear 1080x1920@60 with Horizon Lock and
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
    sync::Arc,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

use crate::{
    telemetry::{v360_ypr, view_matrix},
    types::{AudioMode, CameraAngle, ProjectSource, SmartClip, TelemetryFrame, TELEMETRY_HZ},
};

pub const OUT_W: u32 = 1080;
pub const OUT_H: u32 = 1920;
pub const OUT_FPS: f64 = 60.0;
/// Square v360 canvas that still covers the 1080x1920 crop at any roll (diagonal 2203 px).
const ROT_CANVAS: u32 = 2208;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderSettings {
    pub camera_mode: CameraMode,
    pub horizon_lock: bool,
    /// `.cube` 3D LUT (Flat profile -> Moody Asphalt).
    pub lut_path: Option<PathBuf>,
    /// 0..1, 0.5 = `vignette=PI/4`.
    pub vignette: f64,
    pub hud: bool,
    pub codec: VideoCodec,
    pub bitrate_mbps: u32,
    pub hwaccel_decode: bool,
    /// Per-lens field of view of the X4 fisheyes; tune if seams misalign.
    pub lens_fov_deg: f64,
    /// Horizontal FOV of the 9:16 view; vertical follows from the aspect.
    pub h_fov_deg: f64,
    /// Constant view tilt, negative = look down at the road.
    pub pitch_offset_deg: f64,
    pub sound: SoundSettings,
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
    let layout = match videos.as_slice() {
        [(w0, h0), (w1, h1), ..] if w0 == h0 && w0 == w1 && h0 == h1 => FisheyeLayout::DualStream,
        [(w, h), ..] if *w == 2 * *h => FisheyeLayout::SideBySide,
        other => bail!("unsupported .insv video layout {other:?} (expected dual fisheye)"),
    };
    let audio_channels = streams
        .iter()
        .find(|s| s["codec_type"] == "audio")
        .and_then(|s| s["channels"].as_u64())
        .context("the .insv has no audio stream")? as u32;
    Ok(Probe { layout, audio_channels })
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
    let f = telemetry.get((t_ms * TELEMETRY_HZ / 1000.0).round() as usize);
    let (roll, pitch) = f.map_or((0.0, 0.0), |f| (f.horizon_roll, f.horizon_pitch));
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

fn wrap_deg(d: f64) -> f64 {
    let d = d % 360.0;
    if d > 180.0 { d - 360.0 } else if d < -180.0 { d + 360.0 } else { d }
}

/// sendcmd script: yaw cuts and >= 1° pitch moves to v360, roll to `rotate` every frame it
/// moves by >= 0.05°.
fn camera_script(job: &RenderJob, telemetry: &[TelemetryFrame], frames: usize) -> ((f64, f64, f64), String) {
    let start = job.clip.start_ms;
    let first = view_ypr(job, telemetry, start);
    let (mut yaw, mut pitch, mut roll) = first;
    let mut script = String::new();
    for i in 1..frames {
        let t_rel = i as f64 / OUT_FPS;
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
    let b = bitrate_mbps.clamp(4, 120);
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

pub struct PreparedRender {
    pub args: Vec<OsString>,
    pub frame_count: usize,
    pub output_path: PathBuf,
    pub part_path: PathBuf,
    pub needs_hud_frames: bool,
}

/// Probes, writes the camera script into `work_dir`, runs the loudness pass, and returns the
/// final ffmpeg argument list. ffmpeg writes to `<output>.part` until it succeeds.
pub async fn prepare(job: &RenderJob, telemetry: &[TelemetryFrame], work_dir: &Path) -> Result<PreparedRender> {
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
    let frames = (dur_s * OUT_FPS).round() as usize;
    let encoder = encoder_args(s.codec, s.bitrate_mbps)?;
    let probe = ffprobe(&src.insv_path).await?;

    tokio::fs::create_dir_all(work_dir).await?;
    let ((y0, p0, r0), script) = camera_script(job, telemetry, frames);
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
    args.extend(insv_in);
    let hud_idx = if s.hud {
        args.extend(["-thread_queue_size", "1024", "-f", "image2pipe", "-framerate", "60", "-c:v", "png", "-i", "pipe:0"].map(OsString::from));
        Some(1)
    } else {
        None
    };
    if use_voice_file {
        audio.voice_input = Some(if hud_idx.is_some() { 2 } else { 1 });
        args.extend(voice_in);
    }

    // Square canvas FOV with the same focal length as the 1080-wide view.
    let focal = f64::from(OUT_W) / 2.0 / (s.h_fov_deg.clamp(40.0, 130.0).to_radians() / 2.0).tan();
    let canvas_fov = 2.0 * (f64::from(ROT_CANVAS) / 2.0 / focal).atan().to_degrees();
    let mut g = String::new();
    match probe.layout {
        FisheyeLayout::DualStream => g.push_str("[0:v:0][0:v:1]hstack=inputs=2,"),
        FisheyeLayout::SideBySide => g.push_str("[0:v:0]"),
    }
    let _ = write!(
        g,
        "setpts=PTS-STARTPTS,fps=60,sendcmd=f={cmd},\
         v360@cam=input=dfisheye:output=flat:ih_fov={lf}:iv_fov={lf}:h_fov={cf:.4}:v_fov={cf:.4}:\
         w={ROT_CANVAS}:h={ROT_CANVAS}:interp=cubic:rorder=ypr:yaw={y0:.3}:pitch={p0:.3}:roll=0,\
         rotate@roll=angle={a0:.6}:ow={OUT_W}:oh={OUT_H}:c=black",
        cmd = quoted(&cmd_file)?,
        lf = s.lens_fov_deg,
        cf = canvas_fov,
        a0 = -r0.to_radians(),
    );
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
            "-r", "60",
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

    /// End-to-end on a synthetic `.insv` stand-in (two 1440² streams + stereo audio): probe,
    /// sendcmd v360 + rotate Horizon Lock, Stereo Split ducking, two-pass loudnorm, platform
    /// hardware decode and encode (VideoToolbox on macOS, NVENC elsewhere).
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
                g_lon: 0.0, g_lat: 0.0, speed_kmh: 0.0, lat: 0.0, lon: 0.0,
                audio_rms: 0.0, spectrum_bars: [0.0; 24],
            })
            .collect();
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
            output_path: dir.join("out.mp4"),
            settings: RenderSettings {
                camera_mode: CameraMode::Auto, horizon_lock: true, lut_path: None, vignette: 0.5,
                hud: false, codec: VideoCodec::H264, bitrate_mbps: 25, hwaccel_decode: true,
                lens_fov_deg: 200.0, h_fov_deg: 80.0, pitch_offset_deg: -8.0, sound: default_sound(),
            },
        };
        let p = prepare(&job, &telemetry, &dir).await.unwrap();
        let last = Arc::new(std::sync::Mutex::new(EncodeStats::default()));
        let l2 = last.clone();
        let out = RenderProcess::spawn(p, move |s| *l2.lock().unwrap() = s).unwrap().finish().await.unwrap();
        assert!(!PathBuf::from(format!("{}.part", out.display())).exists());
        assert_eq!(last.lock().unwrap().frame, 180);
        let probe = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0"])
            .arg(&out)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "1080,1920,180");
    }
}
