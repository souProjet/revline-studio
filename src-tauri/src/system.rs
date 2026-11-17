//! What this machine can render with, checked for real (a listed encoder can still fail on a
//! driver that's older than the NVENC API ffmpeg was built against, typical on new RTX 50
//! cards), and a live GPU sampler while renders run.

use std::process::Stdio;

use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

use crate::render_pipeline::{VideoCodec, HWACCEL};

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub driver: String,
    pub memory_total_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderStatus {
    pub codec: VideoCodec,
    pub encoder: Option<String>,
    pub ok: bool,
    /// ffmpeg's error when the test encode failed.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub ffmpeg: Option<String>,
    pub hwaccel: String,
    pub hwaccel_ok: bool,
    pub gpu: Option<GpuInfo>,
    pub encoders: Vec<EncoderStatus>,
    pub cpu_threads: usize,
}

async fn run(cmd: &str, args: &[&str]) -> Option<std::process::Output> {
    Command::new(cmd).args(args).stdin(Stdio::null()).kill_on_drop(true).output().await.ok()
}

async fn test_encode(codec: VideoCodec) -> EncoderStatus {
    let Some(enc) = codec.encoder() else {
        return EncoderStatus { codec, encoder: None, ok: false, detail: Some("No hardware encoder for this codec on this platform".into()) };
    };
    let out = run(
        "ffmpeg",
        &["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=60:d=0.1", "-frames:v", "6", "-c:v", enc, "-f", "null", "-"],
    )
    .await;
    let (ok, detail) = match out {
        Some(o) if o.status.success() => (true, None),
        Some(o) => (false, String::from_utf8_lossy(&o.stderr).lines().rev().find(|l| !l.trim().is_empty()).map(str::to_owned)),
        None => (false, Some("ffmpeg not found".into())),
    };
    EncoderStatus { codec, encoder: Some(enc.into()), ok, detail }
}

pub async fn check() -> SystemInfo {
    let (version, hwaccels, smi, h264, hevc, av1) = tokio::join!(
        run("ffmpeg", &["-hide_banner", "-version"]),
        run("ffmpeg", &["-hide_banner", "-hwaccels"]),
        run("nvidia-smi", &["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]),
        test_encode(VideoCodec::H264),
        test_encode(VideoCodec::Hevc),
        test_encode(VideoCodec::Av1),
    );
    let ffmpeg = version
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| l.trim_start_matches("ffmpeg version ").split(' ').next().unwrap_or("").to_owned()));
    let hwaccel_ok = hwaccels.is_some_and(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == HWACCEL));
    let gpu = smi.filter(|o| o.status.success()).and_then(|o| {
        let line = String::from_utf8_lossy(&o.stdout).lines().next()?.to_owned();
        let mut f = line.split(',').map(str::trim);
        Some(GpuInfo { name: f.next()?.to_owned(), driver: f.next()?.to_owned(), memory_total_mb: f.next()?.parse().unwrap_or(0) })
    });
    SystemInfo {
        ffmpeg,
        hwaccel: HWACCEL.into(),
        hwaccel_ok,
        gpu,
        encoders: vec![h264, hevc, av1],
        cpu_threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct GpuSample {
    /// Percent busy.
    pub sm: f64,
    pub enc: f64,
    pub dec: f64,
    pub mem_used_mb: f64,
}

/// `nvidia-smi dmon` at 1 Hz until the returned child is dropped. None without an NVIDIA
/// driver (macOS, other GPUs).
pub fn spawn_gpu_monitor(on_sample: impl Fn(GpuSample) + Send + 'static) -> Option<Child> {
    let mut child = Command::new("nvidia-smi")
        .args(["dmon", "-s", "um", "-d", "1", "-i", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut cols: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if let Some(h) = line.strip_prefix('#') {
                // "# gpu sm mem enc dec jpg ofa fb bar1 ccpm" then "# Idx % % % % ... MB MB MB"
                if h.split_whitespace().next() == Some("gpu") {
                    cols = h.split_whitespace().map(str::to_owned).collect();
                }
                continue;
            }
            let vals: Vec<&str> = line.split_whitespace().collect();
            let get = |name: &str| cols.iter().position(|c| c == name).and_then(|i| vals.get(i)).and_then(|v| v.parse().ok()).unwrap_or(0.0);
            on_sample(GpuSample { sm: get("sm"), enc: get("enc"), dec: get("dec"), mem_used_mb: get("fb") });
        }
    });
    Some(child)
}
