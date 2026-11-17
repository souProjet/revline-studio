"use client";

import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HighlightList, { fmtTime } from "@/components/HighlightList";
import HudCanvas from "@/components/HudCanvas";
import Inspector from "@/components/Inspector";
import ProxyViewport, { type ProxyViewportHandle } from "@/components/ProxyViewport";
import RenderQueue, { jobProgress, type RenderJobState } from "@/components/RenderQueue";
import Timeline from "@/components/Timeline";
import { Button, Progress, RadioList, Section, Status, TextField } from "@/components/ui";
import { frameIndexAt, type TelemetryTrack } from "@/lib/hud";
import {
  analyzeProject,
  cancelRender,
  getTelemetryWindow,
  onAnalysisProgress,
  onGpuStats,
  onRenderProgress,
  RenderCanceled,
  renderClip,
  scanMedia,
  systemCheck,
} from "@/lib/ipc";
import { DEFAULT_HUD, DEFAULT_SETTINGS, usePersistentState } from "@/lib/settings";
import type { AnalysisProgress, AudioMode, CameraAngle, GpuSample, MediaItem, ProjectAnalysis, ProjectSource, SmartClip, SystemInfo } from "@/lib/types";
import { viewMatrix } from "@/lib/viewMatrix";

const dirOf = (p: string) => p.replace(/[^/]+$/, "");
const baseName = (p: string) => p.split("/").pop() ?? p;
const isActive = (j: RenderJobState) => j.status === "PREPARING" || j.status === "ENCODING";
const isFinished = (j: RenderJobState) => j.status === "DONE" || j.status === "FAILED" || j.status === "CANCELED";

export default function Studio() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [scanRoot, setScanRoot] = useState("");
  const [item, setItem] = useState<MediaItem | null>(null);
  const [audioMode, setAudioMode] = useState<AudioMode>("SingleTrack");
  const [externalPath, setExternalPath] = useState("");
  const [source, setSource] = useState<ProjectSource | null>(null);
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [clips, setClips] = useState<SmartClip[]>([]);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [clipId, setClipId] = useState<string | null>(null);
  const [track, setTrack] = useState<TelemetryTrack>({ frames: [] });
  const [settings, setSettings] = usePersistentState("revline.render.v2", DEFAULT_SETTINGS);
  const [hud, setHud] = usePersistentState("revline.hud.v2", DEFAULT_HUD);
  const [outDir, setOutDir] = usePersistentState("revline.outdir.v1", { path: "" });
  const [safeZones, setSafeZones] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [jobs, setJobs] = useState<RenderJobState[]>([]);
  const [gpu, setGpu] = useState<GpuSample | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const canceled = useRef(new Set<string>());
  const viewport = useRef<ProxyViewportHandle>(null);

  const clip = clips.find((c) => c.id === clipId) ?? null;
  const getTimeMs = useCallback(() => (viewport.current?.video?.currentTime ?? 0) * 1000, []);
  const patchJob = (id: string, patch: Partial<RenderJobState>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  const rendering = jobs.some((j) => !isFinished(j));

  useEffect(() => {
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains");
    setHud((h) => ({ ...h, fontFamily: mono || "monospace" }));
    scanMedia(null).then(setMedia).catch((e) => setError(String(e)));
    systemCheck().then(setSystem).catch(() => undefined);
    const subs = [
      onAnalysisProgress(setProgress),
      onRenderProgress((p) =>
        patchJob(
          p.job_id,
          p.stage === "PREPARING"
            ? { status: "PREPARING" }
            : { status: "ENCODING", total: p.total, frame: p.frame, fps: p.fps, speed: p.speed, sizeBytes: p.size_bytes },
        ),
      ),
      onGpuStats(setGpu),
    ];
    return () => subs.forEach((s) => s.then((u) => u()).catch(() => undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1 Hz clock for elapsed times and ETAs while renders run.
  useEffect(() => {
    if (!rendering) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rendering]);

  // The codec saved last time may not exist on this machine (AV1 on a Mac, older GPU).
  useEffect(() => {
    if (!system) return;
    const ok = system.encoders.filter((e) => e.ok).map((e) => e.codec);
    if (ok.length && !ok.includes(settings.codec)) setSettings((s) => ({ ...s, codec: ok[0]! }));
  }, [system, settings.codec, setSettings]);

  const analyze = async () => {
    if (!item) return;
    const src: ProjectSource = {
      insv_path: item.insv_path,
      lrv_path: item.lrv_path,
      external_audio_path: audioMode === "ExternalVoice" && externalPath ? externalPath : null,
      audio_mode: audioMode,
      sync_offset_ms: 0,
      drift_ppm: 0,
    };
    setError(null);
    setProgress({ stage: "Starting", progress: 0 });
    try {
      const a = await analyzeProject(src);
      setSource({ ...src, sync_offset_ms: a.sync?.offset_ms ?? 0, drift_ppm: a.sync?.drift_ppm ?? 0 });
      setAnalysis(a);
      setClips(a.clips);
      setQueued(new Set(a.clips.slice(0, 3).map((c) => c.id)));
      setClipId(a.clips[0]?.id ?? null);
      setOutDir((d) => (d.path ? d : { path: dirOf(item.insv_path) }));
    } catch (e) {
      setError(`Analysis failed: ${String(e)}`);
    } finally {
      setProgress(null);
    }
  };

  useEffect(() => {
    if (!clip) return;
    let stale = false;
    getTelemetryWindow(clip.start_ms - 90_000, clip.end_ms + 1_000)
      .then((frames) => !stale && setTrack({ frames }))
      .catch((e) => setError(String(e)));
    const v = viewport.current?.video;
    if (v) {
      v.currentTime = clip.start_ms / 1000;
      void v.play().catch(() => undefined);
    }
    return () => {
      stale = true;
    };
    // Only on selection change, not on trims.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  useEffect(() => {
    if (!clip) return;
    const id = setInterval(() => {
      const v = viewport.current?.video;
      if (v && (v.currentTime * 1000 > clip.end_ms || v.currentTime * 1000 < clip.start_ms - 50)) v.currentTime = clip.start_ms / 1000;
    }, 50);
    return () => clearInterval(id);
  }, [clip]);

  const angleAt = useCallback(
    (tMs: number): CameraAngle => {
      if (settings.camera_mode !== "AUTO") return settings.camera_mode;
      let a: CameraAngle = "FRONT";
      for (const k of clip?.camera_keyframes ?? []) if (k.timestamp_ms <= tMs) a = k.angle;
      return a;
    },
    [clip, settings.camera_mode],
  );

  const viewAt = useCallback(
    (tMs: number) => {
      const f = track.frames[frameIndexAt(track, tMs)];
      return viewMatrix(f?.horizon_roll ?? 0, f?.horizon_pitch ?? 0, angleAt(tMs) === "REAR", settings.horizon_lock, settings.pitch_offset_deg);
    },
    [track, angleAt, settings.horizon_lock, settings.pitch_offset_deg],
  );

  const proxySrc = useMemo(() => (source?.lrv_path ? convertFileSrc(source.lrv_path) : null), [source?.lrv_path]);

  const renderQueued = async () => {
    if (!source) return;
    setError(null);
    setArranging(false);
    const list = clips.filter((c) => queued.has(c.id));
    const stamp = Date.now().toString(36);
    const batch: RenderJobState[] = list.map((c) => ({
      id: `${c.id}-${stamp}`,
      label: c.label,
      status: "QUEUED",
      total: 0,
      hudSent: 0,
      frame: 0,
      fps: 0,
      speed: 0,
      sizeBytes: 0,
      startedAt: null,
      finishedAt: null,
      path: null,
      error: null,
    }));
    setJobs((js) => [...batch, ...js.filter((j) => !isFinished(j))]);
    for (const [k, c] of list.entries()) {
      const job = batch[k]!;
      if (canceled.current.has(job.id)) continue;
      patchJob(job.id, { status: "PREPARING", startedAt: Date.now() });
      try {
        const frames = await getTelemetryWindow(c.start_ms - 90_000, c.end_ms + 1_000);
        const done = await renderClip(
          job.id,
          { source, clip: c, output_path: `${(outDir.path || dirOf(source.insv_path)).replace(/\/?$/, "/")}revline_${c.id}.mp4`, settings },
          { frames },
          hud,
          (sent, total) => patchJob(job.id, { hudSent: sent, total }),
          () => canceled.current.has(job.id),
        );
        patchJob(job.id, { status: "DONE", path: done.path, sizeBytes: done.size_bytes, finishedAt: Date.now() });
      } catch (e) {
        if (e instanceof RenderCanceled || canceled.current.has(job.id)) patchJob(job.id, { status: "CANCELED", finishedAt: Date.now() });
        else patchJob(job.id, { status: "FAILED", error: String(e), finishedAt: Date.now() });
      }
    }
    setGpu(null);
  };

  const cancelJob = (id: string) => {
    canceled.current.add(id);
    setJobs((js) => js.map((j) => (j.id === id && j.status === "QUEUED" ? { ...j, status: "CANCELED" } : j)));
    void cancelRender(id).catch(() => undefined);
  };

  const patchClip = (id: string, start_ms: number, end_ms: number) => setClips((cs) => cs.map((c) => (c.id === id ? { ...c, start_ms, end_ms } : c)));

  // Header activity: whatever is running right now, always visible.
  const activeJob = jobs.find(isActive);
  const waiting = jobs.filter((j) => j.status === "QUEUED").length;
  const activity = progress
    ? { label: progress.stage, value: progress.progress, indeterminate: false }
    : activeJob
      ? {
          label: `Rendering ${activeJob.label}${waiting ? `, ${waiting} more queued` : ""}`,
          value: jobProgress(activeJob),
          indeterminate: activeJob.status === "PREPARING",
        }
      : null;

  const codecOk = system?.encoders.find((e) => e.codec === settings.codec)?.ok ?? true;

  return (
    <div className="grid h-dvh grid-cols-[340px_minmax(0,1fr)_340px] grid-rows-[52px_minmax(0,1fr)_212px] bg-surround">
      <header className="col-span-3 flex items-center gap-6 border-b border-hairline bg-panel px-4">
        <span className="font-cond text-[22px] font-bold tracking-[0.02em]">Revline</span>
        <span className="min-w-0 max-w-[280px] truncate font-mono text-[12px] text-muted">{item ? baseName(item.insv_path) : "No recording selected"}</span>
        {analysis && !activity && (
          <div className="flex items-center gap-5 text-[13px]">
            <Status ok={analysis.telemetry.has_imu}>{analysis.telemetry.has_imu ? "IMU" : "No IMU"}</Status>
            <Status ok={analysis.telemetry.has_gps}>{analysis.telemetry.has_gps ? "GPS" : "No GPS"}</Status>
            {analysis.sync && (
              <Status ok={analysis.sync.confidence > 2}>
                Voice synced {analysis.sync.offset_ms >= 0 ? "+" : ""}
                {Math.round(analysis.sync.offset_ms)} ms
              </Status>
            )}
          </div>
        )}
        {activity && (
          <div className="flex min-w-0 flex-1 items-center gap-3" aria-live="polite">
            <span className="min-w-0 truncate text-[13px]">{activity.label}</span>
            <div className="w-40 shrink-0">
              {activity.indeterminate ? (
                <div className="h-1 overflow-hidden rounded-full bg-hairline">
                  <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] bg-straw/70" />
                </div>
              ) : (
                <Progress value={activity.value} />
              )}
            </div>
            {!activity.indeterminate && <span className="w-10 font-mono text-[12px] text-muted">{Math.round(activity.value * 100)} %</span>}
          </div>
        )}
        <div className="ml-auto flex items-center gap-4">
          {system && (
            <span className="hidden text-[12px] text-muted xl:inline" title={system.gpu?.driver ? `Driver ${system.gpu.driver}` : undefined}>
              {system.gpu?.name ?? (system.hwaccel === "videotoolbox" ? "Apple VideoToolbox" : "No GPU encoder")}
            </span>
          )}
          <Button
            variant="primary"
            disabled={!source || queued.size === 0 || rendering || !codecOk}
            onClick={renderQueued}
            className="min-w-[150px]"
            title={codecOk ? undefined : "The selected codec has no working encoder on this machine"}
          >
            {rendering ? "Rendering…" : queued.size === 1 ? "Render 1 clip" : `Render ${queued.size} clips`}
          </Button>
        </div>
      </header>

      <aside className="row-span-2 flex min-h-0 flex-col border-r border-hairline bg-panel">
        <Section title="Recording" aside={media.length > 0 ? `${media.length} found` : undefined}>
          {media.length > 0 ? (
            <ul className="-mx-4 max-h-36 overflow-y-auto" aria-label="Recordings">
              {media.map((m) => {
                const active = item?.insv_path === m.insv_path;
                return (
                  <li key={m.insv_path}>
                    <button
                      type="button"
                      onClick={() => setItem(m)}
                      aria-current={active}
                      className={`flex w-full items-baseline justify-between gap-3 px-4 py-1.5 text-left ${active ? "bg-raised" : "hover:bg-[#27282b]"}`}
                    >
                      <span className={`truncate font-mono text-[12px] ${active ? "text-fg" : "text-muted"}`}>{baseName(m.insv_path)}</span>
                      <span className="shrink-0 text-[12px] text-faint">
                        {(m.size_bytes / 1e9).toFixed(1)} GB{m.lrv_path ? "" : ", no proxy"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted">No Insta360 card found. Insert the SD card, or enter the folder that holds your .insv files.</p>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextField label="Folder" value={scanRoot} placeholder="Auto-detect SD card" onChange={setScanRoot} />
            </div>
            <Button onClick={() => scanMedia(scanRoot || null).then(setMedia).catch((e) => setError(String(e)))}>Scan</Button>
          </div>
          {!analysis && (
            <RadioList
              label="Audio"
              value={audioMode}
              options={[
                ["SingleTrack", "Exhaust only", "One DJI transmitter under the seat"],
                ["StereoSplit", "Exhaust and helmet mic", "Two transmitters, left and right channel"],
                ["ExternalVoice", "Exhaust and phone recording", "Voice from a phone in the helmet, synced automatically"],
              ]}
              onChange={setAudioMode}
            />
          )}
          {!analysis && audioMode === "ExternalVoice" && (
            <TextField label="Phone recording" value={externalPath} placeholder="/path/to/helmet.m4a" onChange={setExternalPath} />
          )}
          <Button variant={analysis ? "secondary" : "primary"} disabled={!item || progress !== null} onClick={analyze} className="w-full">
            {progress ? `${Math.round(progress.progress * 100)} %` : analysis ? "Analyze again" : "Find highlights"}
          </Button>
          {progress && (
            <div className="space-y-1.5" aria-live="polite">
              <Progress value={progress.progress} />
              <p className="text-[12px] text-muted">{progress.stage}</p>
            </div>
          )}
          {analysis?.telemetry.warning && <p className="text-[12px] text-muted">Horizon Lock unavailable: {analysis.telemetry.warning}.</p>}
        </Section>

        <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
          <h2 className="text-[14px] font-semibold">Highlights</h2>
          {clips.length > 0 && (
            <button
              type="button"
              className="text-[12px] text-muted hover:text-fg"
              onClick={() => setQueued(queued.size === clips.length ? new Set() : new Set(clips.map((c) => c.id)))}
            >
              {queued.size === clips.length ? "Select none" : "Select all"}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {clips.length > 0 && analysis ? (
            <HighlightList
              clips={clips}
              actionScore={analysis.exhaust.action_score}
              selectedId={clipId}
              queued={queued}
              onSelect={setClipId}
              onToggleQueue={(id, on) =>
                setQueued((q) => {
                  const n = new Set(q);
                  if (on) n.add(id);
                  else n.delete(id);
                  return n;
                })
              }
            />
          ) : (
            <p className="px-4 text-muted">Pulls, crackles and deep corners show up here after analysis.</p>
          )}
        </div>
      </aside>

      <main className="flex min-h-0 flex-col items-center justify-center gap-3 px-6 py-5">
        <div className="relative aspect-[9/16] h-full max-h-full min-h-0 overflow-hidden rounded-[2px] bg-black">
          <ProxyViewport ref={viewport} src={proxySrc} viewAt={viewAt} lensFovDeg={settings.lens_fov_deg} hFovDeg={settings.h_fov_deg} />
          {settings.vignette > 0 && (
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: `radial-gradient(ellipse at center, transparent ${70 - settings.vignette * 40}%, rgba(0,0,0,${0.3 + settings.vignette * 0.6}) 100%)` }}
            />
          )}
          {settings.hud && (
            <HudCanvas
              track={track}
              getTimeMs={getTimeMs}
              options={hud}
              showSafeZones={safeZones}
              editable={arranging}
              onMove={(el, off) => setHud((h) => ({ ...h, offset: { ...h.offset, [el]: off } }))}
            />
          )}
          {!proxySrc && !arranging && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-10 text-center text-muted">
              {item && !item.lrv_path
                ? "This recording has no .lrv proxy, so it can't be previewed. Highlights and renders still work."
                : "Choose a recording, then find highlights to preview them here."}
            </p>
          )}
        </div>
        <Transport viewport={viewport} clip={clip} angleAt={angleAt} arranging={arranging} onDoneArranging={() => setArranging(false)} />
      </main>

      <aside className="row-span-2 min-h-0 overflow-y-auto border-l border-hairline bg-panel">
        {jobs.length > 0 && (
          <RenderQueue jobs={jobs} gpu={gpu} now={now} onCancel={cancelJob} onClear={() => setJobs((js) => js.filter((j) => !isFinished(j)))} />
        )}
        <Inspector
          settings={settings}
          setSettings={setSettings}
          hud={hud}
          setHud={setHud}
          system={system}
          arranging={arranging}
          setArranging={setArranging}
          safeZones={safeZones}
          setSafeZones={setSafeZones}
          outDir={outDir.path}
          setOutDir={(path) => setOutDir({ path })}
          hasVoice={(analysis?.waveform.voice ?? null) !== null}
        />
      </aside>

      <section className="border-t border-hairline bg-panel py-3 pr-4">
        {analysis && clip ? (
          <Timeline
            analysis={analysis.exhaust}
            waveform={analysis.waveform}
            clip={clip}
            cameraMode={settings.camera_mode}
            getTimeMs={getTimeMs}
            onTrim={(s, e) => patchClip(clip.id, s, e)}
            onSeek={(ms) => {
              const v = viewport.current?.video;
              if (v) v.currentTime = ms / 1000;
            }}
          />
        ) : (
          <p className="flex h-full items-center justify-center text-muted">The selected highlight&apos;s RPM, exhaust and camera cuts appear here.</p>
        )}
      </section>

      {error && (
        <div role="alert" className="fixed bottom-4 left-1/2 flex max-w-[640px] -translate-x-1/2 items-start gap-4 rounded-[3px] bg-raised px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-pop" aria-hidden />
          <p className="min-w-0 flex-1 break-words text-[13px]">{error}</p>
          <button type="button" onClick={() => setError(null)} className="text-[13px] text-muted hover:text-fg">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function Transport({
  viewport,
  clip,
  angleAt,
  arranging,
  onDoneArranging,
}: {
  viewport: React.RefObject<ProxyViewportHandle | null>;
  clip: SmartClip | null;
  angleAt: (tMs: number) => CameraAngle;
  arranging: boolean;
  onDoneArranging: () => void;
}) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  useEffect(() => {
    const id = setInterval(() => {
      const v = viewport.current?.video;
      setT((v?.currentTime ?? 0) * 1000);
      setPlaying(!!v && !v.paused);
    }, 100);
    return () => clearInterval(id);
  }, [viewport]);
  if (arranging) {
    return (
      <div className="flex h-9 w-full max-w-[420px] items-center justify-between">
        <span className="text-[13px] text-muted">Drag HUD elements to move them</span>
        <Button variant="primary" onClick={onDoneArranging}>
          Done
        </Button>
      </div>
    );
  }
  if (!clip) return <div className="h-9" />;
  const v = () => viewport.current?.video;
  return (
    <div className="flex h-9 w-full max-w-[420px] items-center gap-3">
      <button
        type="button"
        onClick={() => {
          const el = v();
          if (!el) return;
          if (el.paused) void el.play();
          else el.pause();
        }}
        aria-label={playing ? "Pause" : "Play"}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-raised text-fg hover:bg-[#35363a]"
      >
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="2" y="1" width="3" height="10" fill="currentColor" />
            <rect x="7" y="1" width="3" height="10" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 1l8 5-8 5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          const el = v();
          if (el) el.muted = !muted;
          setMuted(!muted);
        }}
        aria-label={muted ? "Unmute proxy audio" : "Mute proxy audio"}
        className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M2 5h2.5L8 2v10L4.5 9H2z" fill="currentColor" />
          {muted ? (
            <path d="M10 5l3 4M13 5l-3 4" stroke="currentColor" strokeWidth="1.4" />
          ) : (
            <path d="M10 4.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          )}
        </svg>
      </button>
      <span className="font-mono text-[13px]">
        {fmtTime(t - clip.start_ms)}
        <span className="text-faint"> / {fmtTime(clip.end_ms - clip.start_ms)}</span>
      </span>
      <span className="ml-auto text-[13px] text-muted">{angleAt(t) === "REAR" ? "Rider view" : "Road view"}</span>
    </div>
  );
}
