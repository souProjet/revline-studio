import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { aspectOf, drawHud, hudLayout, type HudOptions, type TelemetryTrack } from "./hud";
import type {
  AnalysisProgress,
  GpuSample,
  MediaItem,
  ProjectAnalysis,
  ProjectSource,
  RenderDone,
  RenderJob,
  RenderProgress,
  RenderStarted,
  SystemInfo,
  TelemetryFrame,
} from "./types";

export const systemCheck = () => invoke<SystemInfo>("system_check");

export const scanMedia = (root: string | null) => invoke<MediaItem[]>("scan_media", { root });

export const analyzeProject = (source: ProjectSource) => invoke<ProjectAnalysis>("analyze_project", { source });

export const getTelemetryWindow = (startMs: number, endMs: number) =>
  invoke<TelemetryFrame[]>("get_telemetry_window", { startMs, endMs });

export const onAnalysisProgress = (cb: (p: AnalysisProgress) => void): Promise<UnlistenFn> =>
  listen<AnalysisProgress>("analysis-progress", (e) => cb(e.payload));

export const onRenderProgress = (cb: (p: RenderProgress) => void): Promise<UnlistenFn> =>
  listen<RenderProgress>("render-progress", (e) => cb(e.payload));

export const onGpuStats = (cb: (s: GpuSample) => void): Promise<UnlistenFn> => listen<GpuSample>("gpu-stats", (e) => cb(e.payload));

export const cancelRender = (jobId: string) => invoke("render_cancel", { jobId });

export class RenderCanceled extends Error {
  constructor() {
    super("Canceled");
  }
}

/** How many PNG encodes run ahead of the IPC send. Each is ~100 kB; 4 keeps the pipe full. */
const PIPELINE = 4;

/**
 * Starts ffmpeg, streams every HUD frame as PNG over raw-body IPC (no JSON/base64), then
 * waits for the encode. `canceled()` is polled between frames.
 */
export async function renderClip(
  jobId: string,
  job: RenderJob,
  track: TelemetryTrack,
  hud: HudOptions,
  onHudFrame: (sent: number, total: number) => void,
  canceled: () => boolean,
): Promise<RenderDone> {
  const started = await invoke<RenderStarted>("render_start", { job, jobId });
  try {
    if (started.needs_hud_frames) {
      const canvas = document.createElement("canvas");
      const { width, height, fps } = job.settings;
      canvas.width = width;
      canvas.height = height;
      const layout = hudLayout(aspectOf(width, height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas unavailable");
      // toBlob copies the bitmap when called, so the next frame can be drawn right away.
      const encode = () =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"),
        );
      const queue: Promise<Blob>[] = [];
      let sent = 0;
      const sendOne = async () => {
        const blob = await queue.shift()!;
        const png = new Uint8Array(await blob.arrayBuffer());
        await invoke("render_push_hud_frame", png, { headers: { "x-job-id": started.job_id } });
        onHudFrame(++sent, started.frame_count);
      };
      for (let i = 0; i < started.frame_count; i++) {
        if (canceled()) throw new RenderCanceled();
        drawHud(ctx, track, job.clip.start_ms + (i * 1000) / fps, hud, layout);
        queue.push(encode());
        if (queue.length >= PIPELINE) await sendOne();
      }
      while (queue.length) await sendOne();
    }
    if (canceled()) throw new RenderCanceled();
    return await invoke<RenderDone>("render_finish", { jobId: started.job_id });
  } catch (e) {
    await cancelRender(started.job_id).catch(() => undefined);
    throw e;
  }
}
