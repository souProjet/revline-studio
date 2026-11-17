#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod audio_analyzer;
pub mod ingest;
pub mod media_proxy;
pub mod plates;
pub mod render_pipeline;
pub mod system;
pub mod telemetry;
pub mod types;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::Context;
use serde::Serialize;
use tauri::{ipc::InvokeBody, AppHandle, Emitter, Manager, RunEvent, State};
use tokio::{process::Child, sync::Mutex};

use audio_analyzer::{ClipContext, ExhaustAnalysis, SyncResult, Waveform};
use render_pipeline::{EncodeStats, PlatePass, RenderJob, RenderProcess};
use telemetry::TelemetrySummary;
use types::{AudioMode, ProjectSource, SmartClip, TelemetryFrame, TELEMETRY_HZ};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Default)]
struct AppState {
    media: Mutex<Option<Arc<media_proxy::MediaProxy>>>,
    /// Full 60 Hz series of the analyzed source; the UI pulls clip-sized windows.
    telemetry: Mutex<Vec<TelemetryFrame>>,
    renders: Mutex<HashMap<String, RenderProcess>>,
    /// Cancel flags of renders still downloading the plate model or detecting plates.
    preparing: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// `nvidia-smi dmon` while at least one render runs.
    gpu_monitor: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct ProjectAnalysis {
    exhaust: ExhaustAnalysis,
    clips: Vec<SmartClip>,
    waveform: Waveform,
    telemetry: TelemetrySummary,
    /// Set in ExternalVoice mode; the UI writes it back into `ProjectSource`.
    sync: Option<SyncResult>,
}

#[derive(Clone, Serialize)]
struct AnalysisProgress {
    stage: &'static str,
    /// Overall 0..1.
    progress: f64,
}

/// Emits overall progress for a stage that spans `[from, to]` of the whole analysis.
fn stage_reporter(app: &AppHandle, stage: &'static str, from: f64, to: f64) -> impl Fn(f64) + Send + Sync + 'static {
    let app = app.clone();
    move |f: f64| {
        let _ = app.emit("analysis-progress", AnalysisProgress { stage, progress: from + (to - from) * f.clamp(0.0, 1.0) });
    }
}

#[tauri::command]
async fn system_check() -> system::SystemInfo {
    system::check().await
}

#[tauri::command]
async fn scan_media(root: Option<PathBuf>) -> Vec<ingest::MediaItem> {
    tokio::task::spawn_blocking(move || ingest::scan(root)).await.unwrap_or_default()
}

#[tauri::command]
async fn analyze_project(app: AppHandle, state: State<'_, AppState>, source: ProjectSource) -> CmdResult<ProjectAnalysis> {
    let mode = source.audio_mode;
    // Stereo Split needs both channels; every other mode only analyzes the exhaust downmix.
    let channels = if mode == AudioMode::StereoSplit { 2 } else { 1 };
    let ext_path = match (mode, &source.external_audio_path) {
        (AudioMode::ExternalVoice, Some(p)) => Some(p.clone()),
        _ => None,
    };
    let decode_end = if ext_path.is_some() { 0.40 } else { 0.50 };
    let planes = audio_analyzer::decode_pcm(&source.insv_path, channels, stage_reporter(&app, "Reading exhaust audio", 0.0, decode_end))
        .await
        .map_err(err)?;
    let external = match &ext_path {
        Some(p) => Some(audio_analyzer::decode_pcm(p, 1, stage_reporter(&app, "Reading phone recording", 0.40, 0.50)).await.map_err(err)?),
        None => None,
    };
    let insv = source.insv_path.clone();
    let app2 = app.clone();

    let (analysis, frames) = tokio::task::spawn_blocking(move || -> anyhow::Result<(ProjectAnalysis, Vec<TelemetryFrame>)> {
        let mut planes = planes.into_iter();
        let exhaust_sig = planes.next().context("no audio channel")?;
        let (sync, voice_sig) = match (mode, external) {
            (AudioMode::StereoSplit, _) => (None, planes.next()),
            (AudioMode::ExternalVoice, Some(ext)) => {
                stage_reporter(&app2, "Syncing phone recording", 0.50, 0.55)(0.0);
                let ext = ext.into_iter().next().context("the phone recording has no audio channel")?;
                let s = audio_analyzer::sync_external(&exhaust_sig, &ext)?;
                let aligned = audio_analyzer::align_external(&ext, exhaust_sig.len(), &s);
                (Some(s), Some(aligned))
            }
            _ => (None, None),
        };

        let exhaust = audio_analyzer::analyze_exhaust_with_progress(&exhaust_sig, &stage_reporter(&app2, "Tracking RPM, shifts and crackles", 0.55, 0.85));
        stage_reporter(&app2, "Building the HUD spectrum", 0.85, 0.9)(0.0);
        let hud = audio_analyzer::hud_audio_frames(&exhaust_sig);
        stage_reporter(&app2, "Reading gyro and GPS", 0.9, 0.97)(0.0);
        let raw = telemetry::parse(&insv).unwrap_or_default();
        let (frames, summary) = telemetry::build_frames(&raw, &hud);
        drop(raw);
        stage_reporter(&app2, "Picking highlights", 0.97, 1.0)(0.0);
        let voice_active = voice_sig.as_deref().map(audio_analyzer::detect_voice);
        let clips = audio_analyzer::generate_smart_clips(&ClipContext {
            analysis: &exhaust,
            voice_active: voice_active.as_deref(),
            telemetry: &frames,
        });
        let waveform = Waveform {
            peaks_per_second: 50,
            exhaust: audio_analyzer::waveform_peaks(&exhaust_sig, 50),
            voice: voice_sig.as_deref().map(|v| audio_analyzer::waveform_peaks(v, 50)),
        };
        Ok((ProjectAnalysis { exhaust, clips, waveform, telemetry: summary, sync }, frames))
    })
    .await
    // A panic in the DSP becomes an error message, not a dead app.
    .map_err(|e| format!("analysis crashed: {e}"))?
    .map_err(err)?;

    *state.telemetry.lock().await = frames;
    stage_reporter(&app, "Done", 1.0, 1.0)(1.0);
    Ok(analysis)
}

#[tauri::command]
async fn preview_media_url(state: State<'_, AppState>, path: PathBuf) -> CmdResult<String> {
    #[cfg(target_os = "linux")]
    {
        let proxy = state.media.lock().await;
        let Some(proxy) = proxy.as_ref() else {
            return Err("media proxy not started".into());
        };
        return proxy.url_for(&path).await.map_err(err);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, path);
        Err("preview_media_url: use convertFileSrc on this platform".into())
    }
}

#[tauri::command]
async fn get_telemetry_window(state: State<'_, AppState>, start_ms: f64, end_ms: f64) -> CmdResult<Vec<TelemetryFrame>> {
    let frames = state.telemetry.lock().await;
    let lo = ((start_ms.max(0.0) * TELEMETRY_HZ / 1000.0) as usize).min(frames.len());
    let hi = ((end_ms * TELEMETRY_HZ / 1000.0).ceil() as usize).clamp(lo, frames.len());
    Ok(frames[lo..hi].to_vec())
}

#[derive(Serialize)]
struct RenderStarted {
    job_id: String,
    frame_count: usize,
    needs_hud_frames: bool,
}

#[derive(Clone, Serialize)]
struct RenderProgress {
    job_id: String,
    stage: &'static str,
    total: usize,
    #[serde(flatten)]
    stats: EncodeStats,
}

async fn ensure_gpu_monitor(app: &AppHandle, state: &AppState) {
    let mut m = state.gpu_monitor.lock().await;
    if m.is_none() {
        let app = app.clone();
        *m = system::spawn_gpu_monitor(move |s| {
            let _ = app.emit("gpu-stats", s);
        });
    }
}

async fn stop_gpu_monitor_if_idle(state: &AppState) {
    if state.renders.lock().await.is_empty() {
        // Dropping the child kills nvidia-smi (kill_on_drop).
        state.gpu_monitor.lock().await.take();
    }
}

#[tauri::command]
async fn render_start(app: AppHandle, state: State<'_, AppState>, job: RenderJob, job_id: String) -> CmdResult<RenderStarted> {
    let emit = |stage: &'static str, total: usize, stats: EncodeStats| {
        let _ = app.emit("render-progress", RenderProgress { job_id: job_id.clone(), stage, total, stats });
    };
    emit("PREPARING", 0, EncodeStats::default());
    let work_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("render");
    let cancel = Arc::new(AtomicBool::new(false));
    state.preparing.lock().await.insert(job_id.clone(), cancel.clone());
    let prepared = async {
        let plate_pass = if job.settings.privacy.plates {
            let dir = app.path().app_data_dir()?.join("models");
            let (app2, id2) = (app.clone(), job_id.clone());
            let model = tokio::task::spawn_blocking(move || {
                plates::ensure_model(&dir, &|f| {
                    let stats = EncodeStats { frame: (f * 100.0).round() as usize, ..EncodeStats::default() };
                    let _ = app2.emit("render-progress", RenderProgress { job_id: id2.clone(), stage: "DOWNLOADING", total: 100, stats });
                })
            })
            .await??;
            let (app2, id2) = (app.clone(), job_id.clone());
            Some(PlatePass {
                model,
                cancel: cancel.clone(),
                on_progress: Arc::new(move |done, total| {
                    let stats = EncodeStats { frame: done, ..EncodeStats::default() };
                    let _ = app2.emit("render-progress", RenderProgress { job_id: id2.clone(), stage: "DETECTING", total, stats });
                }),
            })
        } else {
            None
        };
        if cancel.load(Ordering::Relaxed) {
            anyhow::bail!("canceled");
        }
        let frames = state.telemetry.lock().await.clone();
        render_pipeline::prepare(&job, &frames, &work_dir, plate_pass.as_ref()).await
    }
    .await;
    state.preparing.lock().await.remove(&job_id);
    let prepared = prepared.map_err(err)?;
    let (total, needs_hud_frames) = (prepared.frame_count, prepared.needs_hud_frames);
    emit("ENCODING", total, EncodeStats::default());
    let (app2, id2) = (app.clone(), job_id.clone());
    let process = RenderProcess::spawn(prepared, move |stats| {
        let _ = app2.emit("render-progress", RenderProgress { job_id: id2.clone(), stage: "ENCODING", total, stats });
    })
    .map_err(err)?;
    state.renders.lock().await.insert(job_id.clone(), process);
    ensure_gpu_monitor(&app, &state).await;
    Ok(RenderStarted { job_id, frame_count: total, needs_hud_frames })
}

/// Raw-body IPC: one PNG per call, `x-job-id` header. Frames must arrive in order.
#[tauri::command]
async fn render_push_hud_frame(request: tauri::ipc::Request<'_>, state: State<'_, AppState>) -> CmdResult<()> {
    let InvokeBody::Raw(png) = request.body() else {
        return Err("expected a raw PNG body".into());
    };
    let job_id = request.headers().get("x-job-id").and_then(|v| v.to_str().ok()).ok_or("missing x-job-id header")?;
    let mut renders = state.renders.lock().await;
    let process = renders.get_mut(job_id).ok_or("this render was canceled or has finished")?;
    process.push_hud_frame(png).await.map_err(err)
}

#[derive(Serialize)]
struct RenderDone {
    path: PathBuf,
    size_bytes: u64,
}

#[tauri::command]
async fn render_finish(state: State<'_, AppState>, job_id: String) -> CmdResult<RenderDone> {
    let process = state.renders.lock().await.remove(&job_id).ok_or("this render was canceled")?;
    let result = process.finish().await.map_err(err);
    stop_gpu_monitor_if_idle(&state).await;
    let path = result?;
    let size_bytes = tokio::fs::metadata(&path).await.map_or(0, |m| m.len());
    Ok(RenderDone { path, size_bytes })
}

#[tauri::command]
async fn render_cancel(state: State<'_, AppState>, job_id: String) -> CmdResult<()> {
    if let Some(flag) = state.preparing.lock().await.get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
    let p = state.renders.lock().await.remove(&job_id);
    if let Some(p) = p {
        p.cancel().await;
    }
    stop_gpu_monitor_if_idle(&state).await;
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let state = app.state::<AppState>();
            tauri::async_runtime::block_on(async {
                #[cfg(target_os = "linux")]
                {
                    let proxy = media_proxy::MediaProxy::start().await.map_err(|e| e.to_string())?;
                    *state.media.lock().await = Some(proxy);
                }
                Ok::<(), String>(())
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system_check,
            scan_media,
            analyze_project,
            preview_media_url,
            get_telemetry_window,
            render_start,
            render_push_hud_frame,
            render_finish,
            render_cancel
        ])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Revline Studio failed to start: {e}");
            std::process::exit(1);
        }
    };
    let cleaned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    app.run(move |handle, event| {
        // Quitting mid-render: stop ffmpeg and delete its .part file instead of orphaning both.
        if matches!(event, RunEvent::Exit) && !cleaned.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let state = handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                let jobs: Vec<RenderProcess> = state.renders.lock().await.drain().map(|(_, p)| p).collect();
                for p in jobs {
                    p.cancel().await;
                }
                state.gpu_monitor.lock().await.take();
            });
        }
    });
}
