//! IPC contract shared with `src/lib/types.ts`. Field names and enum spellings are the wire
//! format: change both files together.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SPECTRUM_BARS: usize = 24;
pub const TELEMETRY_HZ: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioMode {
    /// Exhaust only, on both channels of the `.insv` audio.
    SingleTrack,
    /// DJI receiver in stereo mode: channel 0 = exhaust TX, channel 1 = helmet voice TX.
    StereoSplit,
    /// Exhaust from `.insv`, voice from an external phone file synced by cross-correlation.
    ExternalVoice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSource {
    pub insv_path: PathBuf,
    pub lrv_path: Option<PathBuf>,
    pub external_audio_path: Option<PathBuf>,
    pub audio_mode: AudioMode,
    /// external_time = insv_time + sync_offset_ms (+ drift). Positive: the phone started first.
    pub sync_offset_ms: f64,
    /// Clock drift of the external recorder relative to the camera, parts per million.
    pub drift_ppm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryFrame {
    pub timestamp_ms: f64,
    /// Bike lean, degrees, positive = right. Lightly smoothed for display.
    pub lean_angle: f64,
    /// Lens roll relative to gravity, degrees, positive = right, unsmoothed (Horizon Lock input).
    pub horizon_roll: f64,
    /// Lens pitch relative to gravity, degrees, positive = nose up (Horizon Lock input).
    pub horizon_pitch: f64,
    /// Longitudinal acceleration in g, positive = accelerating.
    pub g_lon: f64,
    /// Lateral acceleration in g, positive = toward the right.
    pub g_lat: f64,
    pub speed_kmh: f64,
    pub lat: f64,
    pub lon: f64,
    /// Exhaust loudness for the HUD, 0..1 (maps -60..0 dBFS).
    pub audio_rms: f32,
    /// Exhaust spectrum for the HUD, 0..1 per bar, log-spaced 35 Hz..6 kHz.
    pub spectrum_bars: [f32; SPECTRUM_BARS],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClipTag {
    RpmPeak,
    PopsBangs,
    MaxLean,
    Voice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CameraAngle {
    Front,
    Rear,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraKeyframe {
    /// Absolute source time (same clock as `SmartClip.start_ms`).
    pub timestamp_ms: f64,
    pub angle: CameraAngle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartClip {
    pub id: String,
    pub start_ms: f64,
    pub end_ms: f64,
    /// 0..100
    pub score: f64,
    pub label: String,
    pub tags: Vec<ClipTag>,
    pub camera_keyframes: Vec<CameraKeyframe>,
}
