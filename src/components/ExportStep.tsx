"use client";

import { fmtTime } from "@/components/HighlightList";
import RenderQueue, { type RenderJobState } from "@/components/RenderQueue";
import { aspectOf, outputSize, type Aspect } from "@/lib/hud";
import { bitrateMbps, DEFAULT_SETTINGS } from "@/lib/settings";
import type { GpuSample, Quality, RenderSettings, SmartClip, SystemInfo, VideoCodec } from "@/lib/types";
import { Button, Field, Segmented, Switch, TextField } from "./ui";

const CODEC_NAME: Record<VideoCodec, string> = { H264: "H.264", HEVC: "HEVC", AV1: "AV1" };

const FORMATS: { aspect: Aspect; use: string; w: number; h: number }[] = [
  { aspect: "9:16", use: "TikTok, Reels, Shorts", w: 9, h: 16 },
  { aspect: "4:5", use: "Instagram feed", w: 4, h: 5 },
  { aspect: "1:1", use: "Square feeds", w: 1, h: 1 },
  { aspect: "16:9", use: "YouTube", w: 16, h: 9 },
];

const RESOLUTIONS: [string, string][] = [
  ["720", "720p"],
  ["1080", "1080p"],
  ["1440", "1440p"],
  ["2160", "4K"],
];

interface Props {
  settings: RenderSettings;
  setSettings: (f: (s: RenderSettings) => RenderSettings) => void;
  system: SystemInfo | null;
  outDir: string;
  setOutDir: (v: string) => void;
  clips: SmartClip[];
  queued: Set<string>;
  toggle: (id: string, on: boolean) => void;
  jobs: RenderJobState[];
  gpu: GpuSample | null;
  now: number;
  rendering: boolean;
  onRender: () => void;
  onCancel: (id: string) => void;
  onClear: () => void;
}

export default function ExportStep(p: Props) {
  const s = p.settings;
  const aspect = aspectOf(s.width, s.height);
  const short = Math.min(s.width, s.height);
  const size = (a: Aspect, px: number) => p.setSettings((x) => ({ ...x, ...outputSize(a, px) }));
  const mbps = bitrateMbps(s);
  const mbPerSec = mbps / 8 + 0.04; // video + 320 kb/s audio, MB/s
  const failed = (p.system?.encoders ?? []).filter((e) => !e.ok).map((e) => e.codec);
  const codecOk = !failed.includes(s.codec);
  const chosen = p.clips.filter((c) => p.queued.has(c.id));
  const totalS = chosen.reduce((a, c) => a + (c.end_ms - c.start_ms) / 1000, 0);

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[640px] space-y-8 px-8 py-8">
          <section className="space-y-3">
            <h2 className="font-cond text-[22px] font-semibold">Format</h2>
            <div role="radiogroup" aria-label="Format" className="grid grid-cols-4 gap-3">
              {FORMATS.map((f) => {
                const on = f.aspect === aspect;
                const k = 64 / Math.max(f.w, f.h);
                return (
                  <button
                    key={f.aspect}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => size(f.aspect, short)}
                    className={`flex flex-col items-center gap-3 rounded-[4px] border px-2 pb-3 pt-4 transition-colors duration-150 ${
                      on ? "border-straw bg-raised" : "border-hairline hover:border-[#4a4b50]"
                    }`}
                  >
                    <span className="flex h-16 items-center">
                      <span className={`block rounded-[2px] border-2 ${on ? "border-straw" : "border-muted"}`} style={{ width: f.w * k, height: f.h * k }} />
                    </span>
                    <span className="text-center">
                      <span className="block font-cond text-[18px] font-semibold leading-none">{f.aspect}</span>
                      <span className="mt-1 block text-[12px] text-muted">{f.use}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="font-cond text-[22px] font-semibold">Quality</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Resolution">
                <Segmented label="Resolution" value={String(short)} options={RESOLUTIONS} onChange={(v) => size(aspect, Number(v))} />
              </Field>
              <Field label="Frame rate">
                <Segmented
                  label="Frame rate"
                  value={String(s.fps)}
                  options={[
                    ["30", "30 fps"],
                    ["60", "60 fps"],
                  ]}
                  onChange={(v) => p.setSettings((x) => ({ ...x, fps: Number(v) }))}
                />
              </Field>
            </div>
            <Field label="Bitrate">
              <Segmented<Quality>
                label="Quality"
                value={s.quality}
                options={[
                  ["STANDARD", "Standard"],
                  ["HIGH", "High"],
                  ["MAX", "Maximum"],
                ]}
                onChange={(v) => p.setSettings((x) => ({ ...x, quality: v }))}
              />
            </Field>
            <p className="font-mono text-[12px] text-muted">
              {s.width} × {s.height} · {s.fps} fps · {mbps} Mb/s · about {Math.round(mbPerSec * 60)} MB per minute
            </p>
            {short > 1080 && (
              <p className="text-[12px] text-muted">
                Above 1080p the 360° reprojection runs on the CPU and renders several times slower. TikTok and Instagram re-encode to 1080p anyway.
              </p>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="font-cond text-[22px] font-semibold">Output</h2>
            <TextField label="Save to" value={p.outDir} placeholder="Next to the recording" onChange={p.setOutDir} />
            <details className="group rounded-[4px] border border-hairline">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
                <span>Encoder and hardware</span>
                <span className="text-[12px] text-muted">
                  {CODEC_NAME[s.codec]}
                  {p.system?.gpu ? `, ${p.system.gpu.name}` : p.system?.hwaccel === "videotoolbox" ? ", VideoToolbox" : ""}
                </span>
              </summary>
              <div className="space-y-4 border-t border-hairline px-4 py-4">
                <Field label="Codec" hint={s.codec === "H264" ? "Plays everywhere. HEVC and AV1 give the same quality in smaller files." : undefined}>
                  <Segmented
                    label="Codec"
                    value={s.codec}
                    options={(["H264", "HEVC", "AV1"] as VideoCodec[]).map((c) => [c, CODEC_NAME[c]])}
                    disabled={failed}
                    onChange={(v) => p.setSettings((x) => ({ ...x, codec: v }))}
                  />
                </Field>
                <Switch label="Decode on the GPU" hint="Frees the CPU for the 360° reprojection" on={s.hwaccel_decode} set={(v) => p.setSettings((x) => ({ ...x, hwaccel_decode: v }))} />
                <Hardware system={p.system} />
                <Button variant="ghost" className="-ml-3.5" onClick={() => p.setSettings(() => DEFAULT_SETTINGS)}>
                  Reset all settings
                </Button>
              </div>
            </details>
          </section>
        </div>
      </div>

      <aside className="flex min-h-0 flex-col border-l border-hairline bg-panel">
        <div className="flex items-baseline justify-between px-4 pb-2 pt-5">
          <h2 className="font-cond text-[22px] font-semibold">Clips</h2>
          <span className="text-[12px] text-muted">
            {chosen.length} of {p.clips.length} · {fmtTime(totalS * 1000)}
          </span>
        </div>
        <ul className="max-h-[38%] overflow-y-auto border-y border-hairline" aria-label="Clips to export">
          {p.clips.map((c) => {
            const dur = (c.end_ms - c.start_ms) / 1000;
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-[#27282b]">
                  <input type="checkbox" className="h-4 w-4 accent-[#e0b85c]" checked={p.queued.has(c.id)} onChange={(e) => p.toggle(c.id, e.target.checked)} />
                  <span className="min-w-0 flex-1 truncate font-cond text-[16px] font-semibold">{c.label}</span>
                  <span className="shrink-0 font-mono text-[12px] text-muted">
                    {Math.round(dur)} s · {Math.round(dur * mbPerSec)} MB
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="space-y-2 px-4 py-4">
          <Button
            variant="primary"
            className="h-11 w-full text-[15px]"
            disabled={chosen.length === 0 || p.rendering || !codecOk}
            onClick={p.onRender}
            title={codecOk ? undefined : "The selected codec has no working encoder on this machine"}
          >
            {p.rendering ? "Rendering…" : chosen.length === 1 ? "Render 1 clip" : `Render ${chosen.length} clips`}
          </Button>
          {!codecOk && <p className="text-[12px] text-pop">{CODEC_NAME[s.codec]} has no working encoder here. Pick another codec under Encoder and hardware.</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-hairline">
          {p.jobs.length > 0 ? (
            <RenderQueue jobs={p.jobs} gpu={p.gpu} now={p.now} onCancel={p.onCancel} onClear={p.onClear} />
          ) : (
            <p className="px-4 py-4 text-[13px] text-muted">Renders show up here with their progress, speed and time left.</p>
          )}
        </div>
      </aside>
    </div>
  );
}

function Hardware({ system }: { system: SystemInfo | null }) {
  if (!system) return <p className="text-[12px] text-muted">Checking ffmpeg and the GPU…</p>;
  return (
    <div className="space-y-1.5 rounded-[3px] bg-surround p-3 text-[12px]">
      <Row
        label="GPU"
        value={system.gpu ? `${system.gpu.name}, ${(system.gpu.memory_total_mb / 1024).toFixed(0)} GB` : system.hwaccel === "videotoolbox" ? "Apple VideoToolbox" : "No NVIDIA GPU found"}
        ok={!!system.gpu || system.hwaccel === "videotoolbox"}
      />
      {system.gpu && <Row label="Driver" value={system.gpu.driver} ok />}
      <Row label="ffmpeg" value={system.ffmpeg ?? "Not found on PATH"} ok={!!system.ffmpeg} />
      <Row label="GPU decode" value={system.hwaccel_ok ? system.hwaccel : `${system.hwaccel} unavailable`} ok={system.hwaccel_ok} />
      {system.encoders.map((e) => (
        <div key={e.codec}>
          <Row label={CODEC_NAME[e.codec]} value={e.ok ? (e.encoder ?? "") : "Not available"} ok={e.ok} />
          {!e.ok && e.detail && <p className="mt-0.5 break-words pl-[72px] text-faint">{e.detail}</p>}
        </div>
      ))}
      <Row label="CPU" value={`${system.cpu_threads} threads`} ok />
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="w-[60px] shrink-0 text-muted">{label}</span>
      <span className={`flex min-w-0 items-center gap-1.5 ${ok ? "text-fg" : "text-muted"}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-straw" : "border border-muted"}`} aria-hidden />
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}
