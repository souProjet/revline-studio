//! Insta360 X4 gyro/accel/GPS -> 60 Hz `TelemetryFrame` series (lean, Horizon Lock, g-forces).
//!
//! Why not lean = atan2(accel): in a coordinated turn the specific force points along the
//! bike's own vertical axis, so an accelerometer on the bike reads ~0° at any lean. The lean
//! here comes from the gyro-propagated gravity vector, corrected by the accelerometer only
//! after removing the centripetal term ω × v (v from GPS) and longitudinal dv/dt.
//!
//! Frames: bike frame is x = right, y = down, z = forward (the same axes as the front lens
//! and as ffmpeg's v360 output rays). The mount is auto-calibrated from the data, so the
//! camera's IMU axis convention does not matter.

use std::{
    fs::File,
    io::BufReader,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

use anyhow::{bail, Context, Result};
use telemetry_parser::tags_impl::{GetWithType, GpsData, GroupId, TagId};

use crate::{
    audio_analyzer::HudAudioFrame,
    types::{TelemetryFrame, SPECTRUM_BARS, TELEMETRY_HZ},
};

const G: f64 = 9.806_65;
type V3 = [f64; 3];

fn add(a: V3, b: V3) -> V3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn scale(a: V3, k: f64) -> V3 { [a[0] * k, a[1] * k, a[2] * k] }
fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> f64 { dot(a, a).sqrt() }
fn unit(a: V3) -> V3 { scale(a, 1.0 / norm(a).max(1e-12)) }

#[derive(Debug, Clone, Copy)]
struct ImuSample {
    t_ms: f64,
    /// rad/s, IMU axes
    gyro: V3,
    /// specific force, m/s², IMU axes
    accl: V3,
}

#[derive(Debug, Clone, Copy)]
struct GpsFix {
    t_ms: f64,
    lat: f64,
    lon: f64,
    speed_ms: f64,
}

#[derive(Debug, Default)]
pub struct RawTelemetry {
    imu: Vec<ImuSample>,
    gps: Vec<GpsFix>,
    pub camera_model: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TelemetrySummary {
    pub camera_model: Option<String>,
    pub has_imu: bool,
    pub has_gps: bool,
    pub frame_count: usize,
    pub max_lean_deg: f64,
    pub max_speed_kmh: f64,
    /// Why lean / Horizon Lock are unavailable, when they are.
    pub warning: Option<String>,
}

/// Blocking: parses the `.insv` trailer + metadata with `telemetry-parser`. Run on a
/// blocking thread.
pub fn parse(path: &Path) -> Result<RawTelemetry> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let size = file.metadata()?.len();
    let mut stream = BufReader::with_capacity(1 << 20, file);
    let input = telemetry_parser::Input::from_stream(
        &mut stream,
        size,
        path,
        |_| (),
        Arc::new(AtomicBool::new(false)),
    )
    .with_context(|| format!("telemetry-parser could not read {}", path.display()))?;

    let raw = telemetry_parser::util::normalized_imu(&input, None).unwrap_or_default();
    // Insta360 tags accelerometer data in g; other sources use m/s². Decide from the data.
    let mut mags: Vec<f64> = raw.iter().filter_map(|s| s.accl).map(norm).collect();
    mags.sort_by(f64::total_cmp);
    let accl_scale = match mags.get(mags.len() / 2) {
        Some(m) if *m > 0.3 && *m < 3.0 => G,
        _ => 1.0,
    };
    let imu = raw
        .iter()
        .filter_map(|s| {
            Some(ImuSample {
                t_ms: s.timestamp_ms,
                gyro: scale(s.gyro?, std::f64::consts::PI / 180.0),
                accl: scale(s.accl?, accl_scale),
            })
        })
        .collect();

    // Insta360 GPS records carry UNIX time only and are written while recording, so the
    // first fix is taken as t = 0 of the video (error ~ one GPS period).
    let mut fixes: Vec<GpsData> = Vec::new();
    for sample in input.samples.iter().flatten() {
        if let Some(group) = sample.tag_map.as_ref().and_then(|m| m.get(&GroupId::GPS)) {
            if let Some(v) = GetWithType::<Vec<GpsData>>::get_t(group, TagId::Data) {
                fixes.extend(v.iter().filter(|g| g.is_acquired).cloned());
            }
        }
    }
    fixes.sort_by(|a, b| a.unix_timestamp.total_cmp(&b.unix_timestamp));
    let t0 = fixes.first().map_or(0.0, |g| g.unix_timestamp);
    let gps = fixes
        .iter()
        .map(|g| GpsFix {
            t_ms: (g.unix_timestamp - t0) * 1000.0,
            lat: g.lat,
            lon: g.lon,
            speed_ms: g.speed / 3.6,
        })
        .collect();

    Ok(RawTelemetry { imu, gps, camera_model: input.camera_model().cloned() })
}

/// Bike frame axes expressed in IMU coordinates.
struct MountCalibration {
    right: V3,
    down: V3,
    forward: V3,
    gyro_bias: V3,
}

impl MountCalibration {
    fn to_bike(&self, v: V3) -> V3 {
        [dot(v, self.right), dot(v, self.down), dot(v, self.forward)]
    }
}

/// down: mean specific force over the ride points up (motion averages out).
/// forward: the centripetal term a_c = ω × (v f̂) satisfies a_c · (ω × f̂) = v|ω × f̂|² > 0,
/// and a · (ω × f̂) = f̂ · (a × ω), so f̂ = horizontal part of Σ a × ω over turning samples.
/// Closed form, needs no GPS and no knowledge of the camera's axis convention.
fn calibrate(imu: &[ImuSample]) -> Result<MountCalibration> {
    let still: Vec<&ImuSample> = imu.iter().filter(|s| norm(s.gyro) < 1.5_f64.to_radians()).collect();
    let gyro_bias = if still.len() > 200 {
        scale(still.iter().fold([0.0; 3], |a, s| add(a, s.gyro)), 1.0 / still.len() as f64)
    } else {
        [0.0; 3]
    };
    let up = unit(imu.iter().fold([0.0; 3], |a, s| add(a, s.accl)));
    let down = scale(up, -1.0);

    let c = imu
        .iter()
        .map(|s| (s.accl, sub(s.gyro, gyro_bias)))
        .filter(|(_, w)| norm(*w) > 5f64.to_radians())
        .fold([0.0; 3], |acc, (a, w)| add(acc, cross(a, w)));
    let c_h = sub(c, scale(down, dot(c, down)));
    if norm(c_h) < 1e-6 {
        bail!("not enough cornering in this file to calibrate the camera mount");
    }
    let forward = unit(c_h);
    let right = cross(down, forward);
    Ok(MountCalibration { right, down, forward, gyro_bias })
}

#[derive(Clone, Copy, Default)]
struct State {
    t_ms: f64,
    /// world down, bike frame
    down: V3,
    /// kinematic acceleration, bike frame, m/s²
    a_kin: V3,
}

fn gps_at(gps: &[GpsFix], t_ms: f64) -> Option<GpsFix> {
    let i = gps.partition_point(|g| g.t_ms <= t_ms);
    match (i.checked_sub(1).and_then(|j| gps.get(j)), gps.get(i)) {
        (Some(a), Some(b)) => {
            let k = ((t_ms - a.t_ms) / (b.t_ms - a.t_ms).max(1e-9)).clamp(0.0, 1.0);
            Some(GpsFix {
                t_ms,
                lat: a.lat + (b.lat - a.lat) * k,
                lon: a.lon + (b.lon - a.lon) * k,
                speed_ms: a.speed_ms + (b.speed_ms - a.speed_ms) * k,
            })
        }
        (Some(a), None) => Some(*a),
        (None, Some(b)) => Some(*b),
        (None, None) => None,
    }
}

/// Complementary filter on the gravity direction (time constant 1.5 s with GPS
/// compensation, 6 s without, where uncompensated centripetal force would bias it).
fn fuse(imu: &[ImuSample], gps: &[GpsFix], cal: &MountCalibration) -> Vec<State> {
    let tau_s = if gps.is_empty() { 6.0 } else { 1.5 };
    let mut out = Vec::with_capacity(imu.len());
    let Some(first) = imu.first() else { return out };
    let mut down = unit(scale(cal.to_bike(first.accl), -1.0));
    let mut prev_t = first.t_ms;
    for s in imu {
        let dt = ((s.t_ms - prev_t) / 1000.0).clamp(0.0, 0.05);
        prev_t = s.t_ms;
        let w = cal.to_bike(sub(s.gyro, cal.gyro_bias));
        let f = cal.to_bike(s.accl);
        // A world-fixed vector seen from the rotating body: dd/dt = d × ω.
        down = unit(add(down, scale(cross(down, w), dt)));

        let (v, v_dot) = match (gps_at(gps, s.t_ms - 250.0), gps_at(gps, s.t_ms + 250.0)) {
            (Some(a), Some(b)) => (0.5 * (a.speed_ms + b.speed_ms), (b.speed_ms - a.speed_ms) / 0.5),
            _ => (0.0, 0.0),
        };
        let fwd: V3 = [0.0, 0.0, 1.0];
        let a_model = add(cross(w, scale(fwd, v)), scale(fwd, v_dot));
        let up_meas = sub(f, a_model);
        let g_err = (norm(up_meas) - G).abs() / G;
        if g_err < 0.35 && dt > 0.0 {
            let meas = unit(scale(up_meas, -1.0));
            down = unit(add(down, scale(sub(meas, down), dt / tau_s)));
        }
        out.push(State { t_ms: s.t_ms, down, a_kin: add(f, scale(down, G)) });
    }
    out
}

fn roll_pitch_deg(d: V3) -> (f64, f64) {
    let roll = (-d[0]).atan2(d[1]).to_degrees();
    let pitch = (-d[2]).atan2(d[0].hypot(d[1])).to_degrees();
    (roll, pitch)
}

fn smooth(x: &[f64], half: usize) -> Vec<f64> {
    let mut pre = vec![0.0; x.len() + 1];
    for (i, v) in x.iter().enumerate() {
        pre[i + 1] = pre[i] + v;
    }
    (0..x.len())
        .map(|i| {
            let (lo, hi) = (i.saturating_sub(half), (i + half + 1).min(x.len()));
            (pre[hi] - pre[lo]) / (hi - lo) as f64
        })
        .collect()
}

/// Builds the 60 Hz series. `audio` (also 60 Hz from t = 0) supplies the HUD loudness and
/// spectrum; frame count follows the longer of audio and IMU.
pub fn build_frames(raw: &RawTelemetry, audio: &[HudAudioFrame]) -> (Vec<TelemetryFrame>, TelemetrySummary) {
    let imu_end = raw.imu.last().map_or(0.0, |s| s.t_ms);
    let n = audio.len().max((imu_end * TELEMETRY_HZ / 1000.0) as usize);
    let (states, warning) = if raw.imu.len() < 1_000 {
        (Vec::new(), Some("no IMU data in this file".to_owned()))
    } else {
        match calibrate(&raw.imu) {
            Ok(cal) => (fuse(&raw.imu, &raw.gps, &cal), None),
            Err(e) => (Vec::new(), Some(e.to_string())),
        }
    };

    let mut roll = vec![0.0; n];
    let mut pitch = vec![0.0; n];
    let mut g_lon = vec![0.0; n];
    let mut g_lat = vec![0.0; n];
    let mut j = 0;
    for i in 0..n {
        let t = i as f64 * 1000.0 / TELEMETRY_HZ;
        while j + 1 < states.len() && states[j + 1].t_ms <= t {
            j += 1;
        }
        let Some(s) = states.get(j) else { continue };
        (roll[i], pitch[i]) = roll_pitch_deg(s.down);
        // Level-frame axes: bike forward projected on the horizontal plane.
        let fwd = unit(sub([0.0, 0.0, 1.0], scale(s.down, s.down[2])));
        let right = cross(s.down, fwd);
        g_lon[i] = dot(s.a_kin, fwd) / G;
        g_lat[i] = dot(s.a_kin, right) / G;
    }
    // CP3 vibration: 150 ms on lean display, 300 ms on g-forces. Horizon Lock stays raw.
    let lean = smooth(&roll, 4);
    let g_lon = smooth(&g_lon, 9);
    let g_lat = smooth(&g_lat, 9);

    let mut frames = Vec::with_capacity(n);
    let (mut max_lean, mut max_speed) = (0.0f64, 0.0f64);
    for i in 0..n {
        let t = i as f64 * 1000.0 / TELEMETRY_HZ;
        let fix = gps_at(&raw.gps, t);
        let a = audio.get(i);
        let speed_kmh = fix.map_or(0.0, |g| g.speed_ms * 3.6);
        max_lean = max_lean.max(lean[i].abs());
        max_speed = max_speed.max(speed_kmh);
        frames.push(TelemetryFrame {
            timestamp_ms: t,
            lean_angle: lean[i],
            horizon_roll: roll[i],
            horizon_pitch: pitch[i],
            g_lon: g_lon[i],
            g_lat: g_lat[i],
            speed_kmh,
            lat: fix.map_or(0.0, |g| g.lat),
            lon: fix.map_or(0.0, |g| g.lon),
            audio_rms: a.map_or(0.0, |a| a.rms),
            spectrum_bars: a.map_or([0.0; SPECTRUM_BARS], |a| a.bars),
        });
    }
    let summary = TelemetrySummary {
        camera_model: raw.camera_model.clone(),
        has_imu: !states.is_empty(),
        has_gps: !raw.gps.is_empty(),
        frame_count: n,
        max_lean_deg: max_lean,
        max_speed_kmh: max_speed,
        warning,
    };
    (frames, summary)
}

/// The view rotation for Horizon Lock, shared by the render (v360 yaw/pitch/roll) and the
/// WebGL preview (same matrix in `ProxyViewport`). Returns M with input_ray = M · output_ray,
/// lens/bike axes x = right, y = down, z = forward.
pub fn view_matrix(roll_deg: f64, pitch_deg: f64, rear: bool, lock_horizon: bool) -> [[f64; 3]; 3] {
    let (r, p) = if lock_horizon { (roll_deg.to_radians(), pitch_deg.to_radians()) } else { (0.0, 0.0) };
    // World down in bike coords for this roll/pitch (inverse of `roll_pitch_deg`).
    let down = [-r.sin() * p.cos(), r.cos() * p.cos(), -p.sin()];
    let fwd = unit(sub([0.0, 0.0, 1.0], scale(down, down[2])));
    let right = cross(down, fwd);
    let (rt, fw) = if rear { (scale(right, -1.0), scale(fwd, -1.0)) } else { (right, fwd) };
    // Columns: view x, y, z expressed in lens coordinates.
    [[rt[0], down[0], fw[0]], [rt[1], down[1], fw[1]], [rt[2], down[2], fw[2]]]
}

/// Decomposes M = Ry(yaw) · Rx(pitch) · Rz(roll), which is ffmpeg v360's quaternion order
/// for `rorder=ypr` (vf_v360.c: rot = m[yaw] * m[pitch] * m[roll]). Degrees.
pub fn v360_ypr(m: &[[f64; 3]; 3]) -> (f64, f64, f64) {
    let pitch = (-m[1][2]).clamp(-1.0, 1.0).asin();
    let yaw = m[0][2].atan2(m[2][2]);
    let roll = m[1][0].atan2(m[1][1]);
    (yaw.to_degrees(), pitch.to_degrees(), roll.to_degrees())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_front_is_identity() {
        let (y, p, r) = v360_ypr(&view_matrix(0.0, 0.0, false, true));
        assert!(y.abs() < 1e-9 && p.abs() < 1e-9 && r.abs() < 1e-9);
    }

    #[test]
    fn rear_is_yaw_180() {
        let (y, p, r) = v360_ypr(&view_matrix(0.0, 0.0, true, true));
        assert!((y.abs() - 180.0).abs() < 1e-9 && p.abs() < 1e-9 && r.abs() < 1e-9);
    }

    #[test]
    fn lean_compensation_is_pure_roll_front_and_mirrored_rear() {
        let (_, p, r) = v360_ypr(&view_matrix(40.0, 0.0, false, true));
        assert!(p.abs() < 1e-9 && (r.abs() - 40.0).abs() < 1e-9);
        let (_, _, r_rear) = v360_ypr(&view_matrix(40.0, 0.0, true, true));
        assert!((r + r_rear).abs() < 1e-9);
    }

    #[test]
    fn roll_pitch_round_trip() {
        let m = view_matrix(-30.0, 8.0, false, true);
        let down = [m[0][1], m[1][1], m[2][1]];
        let (r, p) = roll_pitch_deg(down);
        assert!((r + 30.0).abs() < 1e-9 && (p - 8.0).abs() < 1e-9);
    }
}
