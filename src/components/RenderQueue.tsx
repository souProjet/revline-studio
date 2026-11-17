"use client";

import type { GpuSample } from "@/lib/types";
import { Progress } from "./ui";

export type JobStatus = "QUEUED" | "PREPARING" | "ENCODING" | "DONE" | "FAILED" | "CANCELED";

export interface RenderJobState {
  id: string;
  label: string;
  status: JobStatus;
  total: number;
  hudSent: number;
  frame: number;
  fps: number;
  speed: number;
  sizeBytes: number;
  startedAt: number | null;
  finishedAt: number | null;
  path: string | null;
  error: string | null;
}

export const jobProgress = (j: RenderJobState) =>
  j.status === "DONE" ? 1 : j.total > 0 ? Math.min(j.frame, j.hudSent || j.frame) / j.total : 0;

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
};

function detail(j: RenderJobState, now: number): string {
  switch (j.status) {
    case "QUEUED":
      return "Waiting";
    case "PREPARING":
      return "Probing the file and measuring loudness";
    case "ENCODING": {
      const left = j.total - j.frame;
      const eta = j.fps > 0 ? ` · ${dur((left / j.fps) * 1000)} left` : "";
      return `${j.frame} / ${j.total} frames · ${j.fps.toFixed(0)} fps · ${j.speed.toFixed(2)}×${eta}`;
    }
    case "DONE":
      return `${mb(j.sizeBytes)} in ${dur((j.finishedAt ?? now) - (j.startedAt ?? now))}`;
    case "CANCELED":
      return "Canceled, partial file removed";
    case "FAILED":
      return j.error ?? "Failed";
  }
}

interface Props {
  jobs: RenderJobState[];
  gpu: GpuSample | null;
  now: number;
  onCancel: (id: string) => void;
  onClear: () => void;
}

export default function RenderQueue({ jobs, gpu, now, onCancel, onClear }: Props) {
  const running = jobs.some((j) => j.status === "PREPARING" || j.status === "ENCODING" || j.status === "QUEUED");
  return (
    <section aria-label="Renders" className="border-b border-hairline bg-panel px-4 py-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold">Renders</h2>
        {!running && (
          <button type="button" onClick={onClear} className="text-[12px] text-muted hover:text-fg">
            Clear
          </button>
        )}
      </div>
      {gpu && running && (
        <p className="mb-3 font-mono text-[11px] text-muted">
          GPU {gpu.sm.toFixed(0)} % · encode {gpu.enc.toFixed(0)} % · decode {gpu.dec.toFixed(0)} % · {(gpu.mem_used_mb / 1024).toFixed(1)} GB
        </p>
      )}
      <ul className="space-y-3">
        {jobs.map((j) => {
          const active = j.status === "PREPARING" || j.status === "ENCODING";
          return (
            <li key={j.id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={`truncate font-cond text-[16px] font-semibold ${j.status === "QUEUED" || j.status === "CANCELED" ? "text-muted" : "text-fg"}`}>{j.label}</span>
                {(active || j.status === "QUEUED") && (
                  <button type="button" onClick={() => onCancel(j.id)} className="shrink-0 text-[12px] text-muted hover:text-pop">
                    Cancel
                  </button>
                )}
                {j.status === "DONE" && j.path && (
                  <button type="button" onClick={() => navigator.clipboard?.writeText(j.path ?? "")} className="shrink-0 text-[12px] text-muted hover:text-fg">
                    Copy path
                  </button>
                )}
              </div>
              <div className="my-1.5">
                {j.status === "PREPARING" ? (
                  <div className="h-1 overflow-hidden rounded-full bg-hairline">
                    <div className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] bg-straw/70" />
                  </div>
                ) : (
                  <Progress
                    value={jobProgress(j)}
                    secondary={j.status === "ENCODING" && j.total ? j.hudSent / j.total : undefined}
                    tone={j.status === "FAILED" ? "pop" : j.status === "CANCELED" ? "muted" : "straw"}
                  />
                )}
              </div>
              <p className={`break-words text-[12px] ${j.status === "FAILED" ? "text-pop" : "text-muted"}`}>{detail(j, now)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
