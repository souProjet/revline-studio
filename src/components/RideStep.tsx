"use client";

import { useEffect, useState } from "react";
import { previewMediaUrl } from "@/lib/media";
import type { AnalysisProgress, AudioMode, MediaItem } from "@/lib/types";
import { Button, Progress, RadioList, TextField } from "./ui";

interface Props {
  media: MediaItem[];
  item: MediaItem | null;
  setItem: (m: MediaItem) => void;
  scanRoot: string;
  setScanRoot: (v: string) => void;
  onScan: () => void;
  audioMode: AudioMode;
  setAudioMode: (m: AudioMode) => void;
  externalPath: string;
  setExternalPath: (v: string) => void;
  analyzed: boolean;
  onAnalyze: () => void;
  progress: AnalysisProgress | null;
  stages: string[];
}

const baseName = (p: string) => p.split("/").pop() ?? p;

/** "20251102_174512" -> Date, or null when the name doesn't carry a timestamp. */
function recordedAt(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

const fmtDuration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}` : `${Math.round(s / 60)} min`);

/** Front-lens still and duration from the low-res proxy; null when it can't be read. */
function useProxyStill(path: string | null) {
  const [still, setStill] = useState<{ src: string | null; seconds: number | null }>({ src: null, seconds: null });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const v = document.createElement("video");
    v.muted = true;
    v.crossOrigin = "anonymous";
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      if (!alive) return;
      setStill((s) => ({ ...s, seconds: v.duration }));
      v.currentTime = Math.min(30, v.duration * 0.2);
    };
    v.onseeked = () => {
      if (!alive) return;
      const c = document.createElement("canvas");
      c.width = c.height = 240;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      // Left half of the side-by-side proxy is the front lens.
      const side = v.videoHeight;
      ctx.drawImage(v, 0, 0, side, side, 0, 0, 240, 240);
      try {
        setStill((s) => ({ ...s, src: c.toDataURL("image/jpeg", 0.8) }));
      } catch {
        /* tainted canvas: keep the placeholder */
      }
      v.removeAttribute("src");
      v.load();
    };
    void previewMediaUrl(path).then((url) => {
      if (!alive || !url) return;
      v.src = url;
    });
    return () => {
      alive = false;
      v.removeAttribute("src");
      v.load();
    };
  }, [path]);
  return still;
}

function RideCard({ m, selected, onSelect }: { m: MediaItem; selected: boolean; onSelect: () => void }) {
  const still = useProxyStill(m.lrv_path);
  const at = recordedAt(m.recorded_at);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group flex flex-col overflow-hidden rounded-[4px] border text-left transition-colors duration-150 ${
        selected ? "border-straw bg-raised" : "border-hairline bg-panel hover:border-[#4a4b50]"
      }`}
    >
      <span className="relative flex h-[168px] items-center justify-center bg-[#0e0e0f]">
        {still.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={still.src} alt="" className="h-[148px] w-[148px] rounded-full object-cover" />
        ) : (
          <span className="h-[148px] w-[148px] rounded-full border border-hairline bg-[radial-gradient(circle_at_50%_45%,#2c2d30,#121213_70%)]" aria-hidden />
        )}
        {!m.lrv_path && <span className="absolute left-3 top-3 rounded-[2px] bg-surround px-1.5 py-0.5 text-[11px] text-muted">No preview file</span>}
      </span>
      <span className="space-y-1 px-4 pb-4 pt-3">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-cond text-[28px] font-semibold leading-none">
            {at ? at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "Ride"}
          </span>
          {still.seconds !== null && <span className="font-mono text-[12px] text-muted">{fmtDuration(still.seconds)}</span>}
        </span>
        <span className="block text-[13px] text-muted">
          {at ? at.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : baseName(m.insv_path)}
        </span>
        <span className="block truncate font-mono text-[11px] text-faint">
          {baseName(m.insv_path)} · {(m.size_bytes / 1e9).toFixed(1)} GB
        </span>
      </span>
    </button>
  );
}

export default function RideStep(p: Props) {
  const running = p.progress !== null;
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-h-0 overflow-y-auto px-8 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-cond text-[32px] font-semibold leading-none">Choose a ride</h1>
            <p className="mt-2 text-muted">
              {p.media.length > 0
                ? `${p.media.length} ${p.media.length === 1 ? "recording" : "recordings"} from the Insta360 card or folder.`
                : "Insert the camera's SD card, or enter the folder that holds your .insv files."}
            </p>
          </div>
          <div className="flex w-[420px] max-w-full items-end gap-2">
            <div className="flex-1">
              <TextField label="Folder" value={p.scanRoot} placeholder="Find the SD card automatically" onChange={p.setScanRoot} />
            </div>
            <Button onClick={p.onScan}>Scan</Button>
          </div>
        </div>
        {p.media.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {p.media.map((m) => (
              <RideCard key={m.insv_path} m={m} selected={p.item?.insv_path === m.insv_path} onSelect={() => p.setItem(m)} />
            ))}
          </div>
        ) : (
          <div className="flex h-[320px] flex-col items-center justify-center rounded-[4px] border border-dashed border-hairline text-center">
            <p className="font-cond text-[22px] font-semibold">No recordings found</p>
            <p className="mt-1 max-w-[380px] text-muted">Revline looks for DCIM folders on removable drives. Plug in the card or type a folder above, then scan.</p>
          </div>
        )}
      </div>

      <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto border-l border-hairline bg-panel px-5 py-6">
        <RadioList
          label="How was the sound recorded?"
          value={p.audioMode}
          options={[
            ["SingleTrack", "Exhaust only", "One mic or transmitter near the exhaust"],
            ["StereoSplit", "Exhaust and helmet mic", "Two transmitters on the left and right channels"],
            ["ExternalVoice", "Exhaust and phone recording", "Voice recorded on a phone, synced automatically"],
          ]}
          onChange={p.setAudioMode}
        />
        {p.audioMode === "ExternalVoice" && (
          <TextField label="Phone recording" value={p.externalPath} placeholder="/path/to/helmet.m4a" onChange={p.setExternalPath} />
        )}
        <Button variant="primary" className="h-11 w-full text-[15px]" disabled={!p.item || running} onClick={p.onAnalyze}>
          {running ? "Finding highlights…" : p.analyzed ? "Find highlights again" : "Find highlights"}
        </Button>
        {!p.item && <p className="-mt-2 text-[12px] text-muted">Pick a ride first.</p>}
        {(running || p.stages.length > 0) && (
          <ol className="space-y-3" aria-live="polite" aria-label="Analysis">
            {p.stages.map((st, i) => {
              const current = running && i === p.stages.length - 1;
              return (
                <li key={st} className="space-y-1.5">
                  <div className="flex items-center gap-2.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${current ? "border border-straw" : "bg-straw"}`} aria-hidden />
                    <span className={current ? "text-fg" : "text-muted"}>{st}</span>
                    {current && p.progress && <span className="ml-auto font-mono text-[12px] text-muted">{Math.round(p.progress.progress * 100)} %</span>}
                  </div>
                  {current && p.progress && <Progress value={p.progress.progress} />}
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-auto rounded-[4px] bg-surround p-4 text-[13px] text-muted">
          Revline listens to the exhaust for hard pulls, shifts and pops, reads the camera&apos;s gyro and GPS for lean and speed, then proposes the best clips.
        </div>
      </aside>
    </div>
  );
}
