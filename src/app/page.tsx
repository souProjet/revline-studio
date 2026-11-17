"use client";

import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ExportStep from "@/components/ExportStep";
import HighlightList, { fmtTime } from "@/components/HighlightList";
import HudCanvas from "@/components/HudCanvas";
import Inspector from "@/components/Inspector";
import LensSpotOverlay from "@/components/LensSpotOverlay";
import ProxyViewport, { type ProxyViewportHandle } from "@/components/ProxyViewport";
import { isRunning, jobProgress, type RenderJobState } from "@/components/RenderQueue";
import RideStep from "@/components/RideStep";
import Timeline from "@/components/Timeline";
import { Button, Progress, Status } from "@/components/ui";
import { aspectOf, frameIndexAt, hudLayout, type TelemetryTrack } from "@/lib/hud";
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
import { lensFor, viewMatrix } from "@/lib/viewMatrix";

type Step = "ride" | "edit" | "export";

const dirOf = (p: string) => p.replace(/[^/]+$/, "");
const isActive = (j: RenderJobState) => isRunning(j.status);
const isFinished = (j: RenderJobState) => j.status === "DONE" || j.status === "FAILED" || j.status === "CANCELED";

export default function Studio() {
  const [step, setStep] = useState<Step>("ride");
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
  const [marking, setMarking] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [jobs, setJobs] = useState<RenderJobState[]>([]);
  const [gpu, setGpu] = useState<GpuSample | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const canceled = useRef(new Set<string>());
  const viewport = useRef<ProxyViewportHandle>(null);

  const layout = useMemo(() => hudLayout(aspectOf(settings.width, settings.height)), [settings.width, settings.height]);
  const lens = useMemo(
    () => lensFor(settings.width, settings.height, settings.h_fov_deg, settings.lens_fov_deg),
    [settings.width, settings.height, settings.h_fov_deg, settings.lens_fov_deg],
  );
  const clip = clips.find((c) => c.id === clipId) ?? null;
  const getTimeMs = useCallback(() => (viewport.current?.video?.currentTime ?? 0) * 1000, []);
  const patchJob = (id: string, patch: Partial<RenderJobState>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  const rendering = jobs.some((j) => !isFinished(j));
  const pv = settings.privacy;

  useEffect(() => {
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains");
    setHud((h) => ({ ...h, fontFamily: mono || "monospace" }));
    scanMedia(null).then(setMedia).catch((e) => setError(String(e)));
    systemCheck().then(setSystem).catch(() => undefined);
    const subs = [
      onAnalysisProgress((p) => {
        setProgress(p);
        if (p.stage !== "Done") setStages((s) => (s[s.length - 1] === p.stage ? s : [...s, p.stage]));
      }),
      onRenderProgress((p) =>
        patchJob(
          p.job_id,
          p.stage === "ENCODING"
            ? { status: "ENCODING", total: p.total, frame: p.frame, fps: p.fps, speed: p.speed, sizeBytes: p.size_bytes }
            : { status: p.stage, total: p.total, frame: p.frame },
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

  // Arrange and mark modes only make sense while looking at the video.
  useEffect(() => {
    if (step !== "edit") {
      setArranging(false);
      setMarking(false);
    }
  }, [step]);

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
    setStages([]);
    setProgress({ stage: "Starting", progress: 0 });
    try {
      const a = await analyzeProject(src);
      setSource({ ...src, sync_offset_ms: a.sync?.offset_ms ?? 0, drift_ppm: a.sync?.drift_ppm ?? 0 });
      setAnalysis(a);
      setClips(a.clips);
      setQueued(new Set(a.clips.slice(0, 3).map((c) => c.id)));
      setClipId(a.clips[0]?.id ?? null);
      setOutDir((d) => (d.path ? d : { path: dirOf(item.insv_path) }));
      setStep("edit");
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
    return () => {
      stale = true;
    };
    // Only on selection change, not on trims.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  // Seek to the clip when it is selected or when the editor (and its video) mounts again.
  useEffect(() => {
    if (!clip || step !== "edit") return;
    const id = setTimeout(() => {
      const v = viewport.current?.video;
      if (!v) return;
      v.currentTime = clip.start_ms / 1000;
      void v.play().catch(() => undefined);
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, step]);

  useEffect(() => {
    if (!clip || step !== "edit") return;
    const id = setInterval(() => {
      const v = viewport.current?.video;
      if (v && (v.currentTime * 1000 > clip.end_ms || v.currentTime * 1000 < clip.start_ms - 50)) v.currentTime = clip.start_ms / 1000;
    }, 50);
    return () => clearInterval(id);
  }, [clip, step]);

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

  const speedAt = useCallback((tMs: number) => track.frames[frameIndexAt(track, tMs)]?.speed_kmh ?? 0, [track]);

  const tooFast = useMemo(() => {
    const spans: [number, number][] = [];
    for (const f of track.frames) {
      if (f.speed_kmh <= pv.speed_limit_kmh) continue;
      const last = spans[spans.length - 1];
      if (last && f.timestamp_ms - last[1] < 1000) last[1] = f.timestamp_ms;
      else spans.push([f.timestamp_ms, f.timestamp_ms]);
    }
    return spans;
  }, [track, pv.speed_limit_kmh]);

  const proxySrc = useMemo(() => (source?.lrv_path ? convertFileSrc(source.lrv_path) : null), [source?.lrv_path]);

  const renderQueued = async () => {
    if (!source) return;
    setError(null);
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
          {
            source,
            clip: c,
            output_path: `${(outDir.path || dirOf(source.insv_path)).replace(/\/?$/, "/")}revline_${c.id}_${settings.width}x${settings.height}.mp4`,
            settings,
          },
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

  const toggle = (id: string, on: boolean) =>
    setQueued((q) => {
      const n = new Set(q);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const patchClip = (id: string, start_ms: number, end_ms: number) => setClips((cs) => cs.map((c) => (c.id === id ? { ...c, start_ms, end_ms } : c)));

  // Whatever is running right now, visible from every step.
  const activeJob = jobs.find(isActive);
  const waiting = jobs.filter((j) => j.status === "QUEUED").length;
  const activity = progress
    ? { label: progress.stage, value: progress.progress, indeterminate: false }
    : activeJob
      ? {
          label: `${activeJob.status === "DETECTING" ? "Finding plates in" : activeJob.status === "DOWNLOADING" ? "Downloading the plate detector for" : "Rendering"} ${activeJob.label}${waiting ? `, ${waiting} more queued` : ""}`,
          value: jobProgress(activeJob),
          indeterminate: activeJob.status === "PREPARING",
        }
      : null;

  const steps: [Step, string, boolean][] = [
    ["ride", "Ride", true],
    ["edit", "Edit", !!analysis],
    ["export", "Export", !!analysis],
  ];

  return (
    <div className="grid h-dvh grid-rows-[56px_minmax(0,1fr)] bg-surround">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-6 border-b border-hairline bg-panel px-5">
        <div className="flex min-w-0 items-center gap-5">
          <span className="font-cond text-[22px] font-bold tracking-[0.02em]">Revline</span>
          {analysis && (
            <div className="hidden items-center gap-4 text-[12px] lg:flex">
              <Status ok={analysis.telemetry.has_imu}>{analysis.telemetry.has_imu ? "Gyro" : "No gyro"}</Status>
              <Status ok={analysis.telemetry.has_gps}>{analysis.telemetry.has_gps ? "GPS" : "No GPS"}</Status>
              {analysis.sync && <Status ok={analysis.sync.confidence > 2}>Voice synced</Status>}
            </div>
          )}
        </div>
        <nav aria-label="Steps" className="flex items-center gap-1">
          {steps.map(([s, label, enabled], i) => (
            <button
              key={s}
              type="button"
              disabled={!enabled}
              aria-current={step === s ? "step" : undefined}
              onClick={() => setStep(s)}
              className={`flex h-9 items-center gap-2 rounded-[3px] px-3 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-35 ${
                step === s ? "bg-raised text-fg" : "text-muted hover:text-fg"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px] ${step === s ? "bg-straw text-straw-ink" : "border border-hairline"}`}
              >
                {i + 1}
              </span>
              <span className="text-[14px] font-medium">{label}</span>
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 items-center justify-end gap-3" aria-live="polite">
          {activity ? (
            <>
              <span className="min-w-0 truncate text-[13px]">{activity.label}</span>
              <div className="w-32 shrink-0">
                {activity.indeterminate ? (
                  <div className="h-1 overflow-hidden rounded-full bg-hairline">
                    <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] bg-straw/70" />
                  </div>
                ) : (
                  <Progress value={activity.value} />
                )}
              </div>
              {!activity.indeterminate && <span className="w-9 text-right font-mono text-[12px] text-muted">{Math.round(activity.value * 100)}%</span>}
            </>
          ) : (
            system && (
              <span className="truncate text-[12px] text-muted" title={system.gpu?.driver ? `Driver ${system.gpu.driver}` : undefined}>
                {system.gpu?.name ?? (system.hwaccel === "videotoolbox" ? "Apple VideoToolbox" : "No GPU encoder")}
              </span>
            )
          )}
        </div>
      </header>

      {step === "ride" && (
        <RideStep
          media={media}
          item={item}
          setItem={setItem}
          scanRoot={scanRoot}
          setScanRoot={setScanRoot}
          onScan={() => scanMedia(scanRoot || null).then(setMedia).catch((e) => setError(String(e)))}
          audioMode={audioMode}
          setAudioMode={setAudioMode}
          externalPath={externalPath}
          setExternalPath={setExternalPath}
          analyzed={!!analysis}
          onAnalyze={analyze}
          progress={progress}
          stages={stages}
        />
      )}

      {step === "edit" && analysis && (
        <div className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)_340px] grid-rows-[minmax(0,1fr)_212px]">
          <aside className="row-span-2 flex min-h-0 flex-col border-r border-hairline bg-panel">
            <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
              <h2 className="font-cond text-[20px] font-semibold">Highlights</h2>
              <button
                type="button"
                className="text-[12px] text-muted hover:text-fg"
                onClick={() => setQueued(queued.size === clips.length ? new Set() : new Set(clips.map((c) => c.id)))}
              >
                {queued.size === clips.length ? "Export none" : "Export all"}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {clips.length > 0 ? (
                <HighlightList
                  clips={clips}
                  actionScore={analysis.exhaust.action_score}
                  selectedId={clipId}
                  queued={queued}
                  onSelect={setClipId}
                  onToggleQueue={toggle}
                />
              ) : (
                <p className="px-4 text-muted">No highlight stood out in this ride. Try another recording.</p>
              )}
            </div>
            {analysis.telemetry.warning && <p className="border-t border-hairline px-4 py-3 text-[12px] text-muted">Horizon Lock is off: {analysis.telemetry.warning}.</p>}
            <div className="border-t border-hairline p-4">
              <Button variant="primary" className="h-11 w-full text-[15px]" disabled={queued.size === 0} onClick={() => setStep("export")}>
                {queued.size === 0 ? "Pick clips to export" : `Export ${queued.size} ${queued.size === 1 ? "clip" : "clips"}`}
              </Button>
            </div>
          </aside>

          <main className="flex min-h-0 flex-col items-center justify-center gap-3 px-6 py-5">
            <div
              className={`relative max-h-full min-h-0 max-w-full overflow-hidden rounded-[2px] bg-black ${settings.width > settings.height ? "w-full" : "h-full"}`}
              style={{ aspectRatio: `${settings.width} / ${settings.height}` }}
            >
              <ProxyViewport
                ref={viewport}
                src={proxySrc}
                viewAt={viewAt}
                lensFovDeg={settings.lens_fov_deg}
                hFovDeg={settings.h_fov_deg}
                width={settings.width}
                height={settings.height}
              />
              {settings.vignette > 0 && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{ background: `radial-gradient(ellipse at center, transparent ${70 - settings.vignette * 40}%, rgba(0,0,0,${0.3 + settings.vignette * 0.6}) 100%)` }}
                />
              )}
              {pv.dashboard !== "OFF" && (
                <LensSpotOverlay
                  spot={pv.dashboard_spot}
                  marking={marking}
                  activeAt={(t) => pv.dashboard === "ALWAYS" || speedAt(t) > pv.speed_limit_kmh}
                  viewAt={viewAt}
                  getTimeMs={getTimeMs}
                  lens={lens}
                  onPlace={(spot) => setSettings((x) => ({ ...x, privacy: { ...x.privacy, dashboard_spot: spot } }))}
                />
              )}
              {settings.hud && !marking && (
                <HudCanvas
                  track={track}
                  getTimeMs={getTimeMs}
                  options={hud}
                  layout={layout}
                  hideSpeedAbove={pv.hide_hud_speed ? pv.speed_limit_kmh : null}
                  showSafeZones={safeZones}
                  editable={arranging}
                  onMove={(el, off) => setHud((h) => ({ ...h, offset: { ...h.offset, [layout.aspect]: { ...h.offset[layout.aspect], [el]: off } } }))}
                />
              )}
              {!proxySrc && (
                <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-10 text-center text-muted">
                  This recording has no .lrv preview file, so it can&apos;t be shown here. Highlights and renders still work.
                </p>
              )}
            </div>
            <Transport
              viewport={viewport}
              clip={clip}
              angleAt={angleAt}
              speedAt={speedAt}
              limit={pv.speed_limit_kmh}
              mode={arranging ? "arrange" : marking ? "mark" : null}
              onDone={() => {
                setArranging(false);
                setMarking(false);
              }}
            />
          </main>

          <aside className="row-span-2 flex min-h-0 flex-col border-l border-hairline bg-panel">
            <Inspector
              settings={settings}
              setSettings={setSettings}
              hud={hud}
              setHud={setHud}
              arranging={arranging}
              setArranging={(v) => {
                setArranging(v);
                if (v) setMarking(false);
              }}
              marking={marking}
              setMarking={(v) => {
                setMarking(v);
                if (v) setArranging(false);
              }}
              safeZones={safeZones}
              setSafeZones={setSafeZones}
              hasVoice={(analysis.waveform.voice ?? null) !== null}
            />
          </aside>

          <section className="border-t border-hairline bg-panel py-3 pr-4">
            {clip ? (
              <Timeline
                analysis={analysis.exhaust}
                waveform={analysis.waveform}
                clip={clip}
                cameraMode={settings.camera_mode}
                getTimeMs={getTimeMs}
                alerts={tooFast}
                onTrim={(s, e) => patchClip(clip.id, s, e)}
                onSeek={(ms) => {
                  const v = viewport.current?.video;
                  if (v) v.currentTime = ms / 1000;
                }}
              />
            ) : (
              <p className="flex h-full items-center justify-center text-muted">Pick a highlight to see its RPM, exhaust and camera cuts.</p>
            )}
          </section>
        </div>
      )}

      {step === "export" && (
        <ExportStep
          settings={settings}
          setSettings={setSettings}
          system={system}
          outDir={outDir.path}
          setOutDir={(path) => setOutDir({ path })}
          clips={clips}
          queued={queued}
          toggle={toggle}
          jobs={jobs}
          gpu={gpu}
          now={now}
          rendering={rendering}
          onRender={renderQueued}
          onCancel={cancelJob}
          onClear={() => setJobs((js) => js.filter((j) => !isFinished(j)))}
        />
      )}

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
  speedAt,
  limit,
  mode,
  onDone,
}: {
  viewport: React.RefObject<ProxyViewportHandle | null>;
  clip: SmartClip | null;
  angleAt: (tMs: number) => CameraAngle;
  speedAt: (tMs: number) => number;
  limit: number;
  mode: "arrange" | "mark" | null;
  onDone: () => void;
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
  if (mode) {
    return (
      <div className="flex h-10 w-full max-w-[460px] items-center justify-between gap-4 rounded-[3px] bg-raised px-3">
        <span className="text-[13px]">{mode === "arrange" ? "Drag HUD elements to move them" : "Click the bike's dashboard in the video"}</span>
        <Button variant="primary" className="h-8" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }
  if (!clip) return <div className="h-10" />;
  const v = () => viewport.current?.video;
  const speed = speedAt(t);
  const fast = speed > limit;
  return (
    <div className="flex h-10 w-full max-w-[460px] items-center gap-3">
      <button
        type="button"
        onClick={() => {
          const el = v();
          if (!el) return;
          if (el.paused) void el.play();
          else el.pause();
        }}
        aria-label={playing ? "Pause" : "Play"}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-raised text-fg hover:bg-[#35363a]"
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
        aria-label={muted ? "Unmute preview audio" : "Mute preview audio"}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M2 5h2.5L8 2v10L4.5 9H2z" fill="currentColor" />
          {muted ? <path d="M10 5l3 4M13 5l-3 4" stroke="currentColor" strokeWidth="1.4" /> : <path d="M10 4.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.4" />}
        </svg>
      </button>
      <span className="font-mono text-[13px]">
        {fmtTime(t - clip.start_ms)}
        <span className="text-faint"> / {fmtTime(clip.end_ms - clip.start_ms)}</span>
      </span>
      <span className="ml-auto flex items-center gap-3 text-[13px]">
        <span className={`font-mono ${fast ? "text-pop" : "text-muted"}`} title={fast ? `Above your ${limit} km/h limit` : undefined}>
          {Math.round(speed)} km/h
        </span>
        <span className="text-muted">{angleAt(t) === "REAR" ? "Rider" : "Road"}</span>
      </span>
    </div>
  );
}
