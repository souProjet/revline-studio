// Mirror of src-tauri/src/types.rs (+ command payloads). Change both sides together.

export type AudioMode = "SingleTrack" | "StereoSplit" | "ExternalVoice";

export interface ProjectSource {
  insv_path: string;
  lrv_path: string | null;
  external_audio_path: string | null;
  audio_mode: AudioMode;
  sync_offset_ms: number;
  drift_ppm: number;
}

export const SPECTRUM_BARS = 24;
export const TELEMETRY_HZ = 60;

export interface TelemetryFrame {
  timestamp_ms: number;
  /** degrees, + = right, display-smoothed */
  lean_angle: number;
  /** degrees, + = right, raw (Horizon Lock) */
  horizon_roll: number;
  /** degrees, + = nose up (Horizon Lock) */
  horizon_pitch: number;
  g_lon: number;
  g_lat: number;
  speed_kmh: number;
  lat: number;
  lon: number;
  audio_rms: number;
  spectrum_bars: number[]; // length SPECTRUM_BARS, 0..1
}

export type ClipTag = "RPM_PEAK" | "POPS_BANGS" | "MAX_LEAN" | "VOICE";
export type CameraAngle = "FRONT" | "REAR";

export interface CameraKeyframe {
  timestamp_ms: number;
  angle: CameraAngle;
}

export interface SmartClip {
  id: string;
  start_ms: number;
  end_ms: number;
  score: number;
  label: string;
  tags: ClipTag[];
  camera_keyframes: CameraKeyframe[];
}

// ---- analysis payloads -------------------------------------------------------------

export interface MediaItem {
  insv_path: string;
  lrv_path: string | null;
  size_bytes: number;
  recorded_at: string;
}

export interface AudioEvent {
  timestamp_ms: number;
  kind: "UPSHIFT" | "POP";
  magnitude: number;
}

export interface ExhaustAnalysis {
  duration_ms: number;
  hop_ms: number;
  rpm: number[];
  action_score: number[];
  events: AudioEvent[];
}

export interface Waveform {
  peaks_per_second: number;
  exhaust: [number, number][];
  voice: [number, number][] | null;
}

export interface TelemetrySummary {
  camera_model: string | null;
  has_imu: boolean;
  has_gps: boolean;
  frame_count: number;
  max_lean_deg: number;
  max_speed_kmh: number;
  warning: string | null;
}

export interface SyncResult {
  offset_ms: number;
  drift_ppm: number;
  confidence: number;
}

export interface ProjectAnalysis {
  exhaust: ExhaustAnalysis;
  clips: SmartClip[];
  waveform: Waveform;
  telemetry: TelemetrySummary;
  sync: SyncResult | null;
}

// ---- render ------------------------------------------------------------------------

export type CameraMode = "FRONT" | "REAR" | "AUTO";
export type VideoCodec = "H264" | "HEVC" | "AV1";

export interface SoundSettings {
  exhaust_eq: boolean;
  highpass_hz: number;
  body_hz: number;
  body_gain_db: number;
  rasp_hz: number;
  rasp_gain_db: number;
  exhaust_gain_db: number;
  voice_gain_db: number;
  voice_denoise_db: number;
  voice_denoise_model: string | null;
  ducking: boolean;
  ducking_db: number;
  loudness_lufs: number;
  true_peak_db: number;
}

export type Quality = "STANDARD" | "HIGH" | "MAX";

export type BlurWhen = "OFF" | "ABOVE_LIMIT" | "ALWAYS";

/** A fixed spot in one lens image (u, v 0..1; radius as a fraction of the lens width). */
export interface LensSpot {
  lens: CameraAngle;
  u: number;
  v: number;
  radius: number;
}

export interface PrivacySettings {
  speed_limit_kmh: number;
  hide_hud_speed: boolean;
  dashboard: BlurWhen;
  dashboard_spot: LensSpot | null;
  plates: boolean;
}

export interface RenderSettings {
  camera_mode: CameraMode;
  horizon_lock: boolean;
  lut_path: string | null;
  /** 0..1, 0.5 = vignette=PI/4 */
  vignette: number;
  hud: boolean;
  codec: VideoCodec;
  quality: Quality;
  /** Output frame size, both even; the aspect follows from it. */
  width: number;
  height: number;
  fps: number;
  hwaccel_decode: boolean;
  lens_fov_deg: number;
  h_fov_deg: number;
  pitch_offset_deg: number;
  sound: SoundSettings;
  privacy: PrivacySettings;
}

export interface RenderJob {
  source: ProjectSource;
  clip: SmartClip;
  output_path: string;
  settings: RenderSettings;
}

export interface RenderStarted {
  job_id: string;
  frame_count: number;
  needs_hud_frames: boolean;
}

export interface RenderProgress {
  job_id: string;
  stage: "PREPARING" | "DOWNLOADING" | "DETECTING" | "ENCODING";
  total: number;
  frame: number;
  fps: number;
  speed: number;
  size_bytes: number;
}

export interface RenderDone {
  path: string;
  size_bytes: number;
}

export interface AnalysisProgress {
  stage: string;
  progress: number;
}

// ---- hardware ----------------------------------------------------------------------

export interface EncoderStatus {
  codec: VideoCodec;
  encoder: string | null;
  ok: boolean;
  detail: string | null;
}

export interface SystemInfo {
  ffmpeg: string | null;
  hwaccel: string;
  hwaccel_ok: boolean;
  gpu: { name: string; driver: string; memory_total_mb: number } | null;
  encoders: EncoderStatus[];
  cpu_threads: number;
}

export interface GpuSample {
  sm: number;
  enc: number;
  dec: number;
  mem_used_mb: number;
}
