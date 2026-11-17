"use client";

import { useEffect, useRef } from "react";
import { heat, rpmHeat } from "@/lib/heat";
import type { CameraMode, ExhaustAnalysis, SmartClip, Waveform } from "@/lib/types";

interface Props {
  analysis: ExhaustAnalysis;
  waveform: Waveform;
  clip: SmartClip;
  cameraMode: CameraMode;
  getTimeMs: () => number;
  onTrim: (startMs: number, endMs: number) => void;
  onSeek: (ms: number) => void;
}

const PAD_MS = 4_000;
const RULER = 20;
const GAP = 4;
interface Lane {
  name: string;
  h: number;
}

const C = {
  fg: "#ebe8e3",
  muted: "#a29f99",
  faint: "#6f6d69",
  hairline: "#36373b",
  raised: "#2c2d30",
  straw: "#e0b85c",
  pop: "#ff2a54",
  dim: "rgba(26,26,27,0.72)",
};

function lanesFor(hasVoice: boolean): Lane[] {
  const l = [
    { name: "Camera", h: 18 },
    { name: "RPM", h: 40 },
    { name: "Exhaust", h: 48 },
  ];
  if (hasVoice) l.push({ name: "Voice", h: 28 });
  return l;
}

/** Clip ± 4 s. RPM in the heat-tint scale, pops and shifts on the exhaust lane, trim brackets. */
export default function Timeline({ analysis, waveform, clip, cameraMode, getTimeMs, onTrim, onSeek }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ analysis, waveform, clip, cameraMode, getTimeMs });
  live.current = { analysis, waveform, clip, cameraMode, getTimeMs };
  const drag = useRef<{ edge: "start" | "end"; t0: number; t1: number } | null>(null);
  const lanes = lanesFor(waveform.voice !== null);

  const range = (): readonly [number, number] => {
    if (drag.current) return [drag.current.t0, drag.current.t1]; // freeze the scale while trimming
    const c = live.current.clip;
    return [Math.max(0, c.start_ms - PAD_MS), Math.min(live.current.analysis.duration_ms, c.end_ms + PAD_MS)];
  };

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const root = getComputedStyle(document.documentElement);
    const font = root.getPropertyValue("--font-jetbrains") || "monospace";
    const sans = root.getPropertyValue("--font-barlow") || "sans-serif";
    let raf = 0;
    const draw = () => {
      const { analysis, waveform, clip, cameraMode, getTimeMs } = live.current;
      const lanes = lanesFor(waveform.voice !== null);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const [t0, t1] = range();
      const x = (ms: number) => ((ms - t0) / (t1 - t0)) * w;
      const msAtPx = (px: number) => t0 + (px / w) * (t1 - t0);

      // Ruler: 1 s ticks, labels every 5 s.
      ctx.font = `10px ${font}`;
      ctx.textBaseline = "top";
      for (let s = Math.ceil(t0 / 1000); s * 1000 <= t1; s++) {
        const px = Math.round(x(s * 1000)) + 0.5;
        const major = s % 5 === 0;
        ctx.fillStyle = major ? C.muted : C.hairline;
        ctx.fillRect(px, major ? 10 : 14, 1, major ? 10 : 6);
        if (major) ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, px + 3, 1);
      }

      let top = RULER + GAP;
      const laneTop: Record<string, number> = {};
      for (const l of lanes) {
        laneTop[l.name] = top;
        top += l.h + GAP;
      }

      // Camera shots.
      {
        const y = laneTop.Camera!;
        const shots =
          cameraMode === "AUTO"
            ? clip.camera_keyframes
            : [{ timestamp_ms: clip.start_ms, angle: cameraMode === "REAR" ? "REAR" : "FRONT" }];
        shots.forEach((k, i) => {
          const a = x(Math.max(k.timestamp_ms, clip.start_ms));
          const b = x(shots[i + 1]?.timestamp_ms ?? clip.end_ms);
          ctx.fillStyle = k.angle === "REAR" ? "rgba(224,184,92,0.28)" : C.raised;
          ctx.fillRect(a + 1, y, Math.max(0, b - a - 2), 18);
          if (b - a > 48) {
            ctx.fillStyle = k.angle === "REAR" ? C.straw : C.muted;
            ctx.font = `500 12px ${sans}`;
            ctx.textBaseline = "middle";
            ctx.fillText(k.angle === "REAR" ? "Rear" : "Front", a + 6, y + 9.5);
          }
        });
      }

      // RPM as a heat-tint area.
      {
        const y = laneTop.RPM!;
        const lh = 40;
        for (let px = 0; px < w; px++) {
          const r = analysis.rpm[Math.floor(msAtPx(px) / analysis.hop_ms)] ?? 0;
          if (r <= 0) continue;
          const t = Math.max(0, Math.min(1, rpmHeat(r)));
          const bh = Math.max(1, t * lh);
          ctx.fillStyle = heat(t);
          ctx.fillRect(px, y + lh - bh, 1, bh);
        }
      }

      // Waveform lanes.
      const wave = (peaks: [number, number][], y: number, lh: number, color: string) => {
        const pps = waveform.peaks_per_second;
        const mid = y + lh / 2;
        ctx.fillStyle = color;
        for (let px = 0; px < w; px++) {
          const p = peaks[Math.floor((msAtPx(px) / 1000) * pps)];
          if (!p) continue;
          ctx.fillRect(px, mid - p[1] * (lh / 2), 1, Math.max(1, (p[1] - p[0]) * (lh / 2)));
        }
      };
      wave(waveform.exhaust, laneTop.Exhaust!, 48, "rgba(235,232,227,0.62)");
      if (waveform.voice && laneTop.Voice !== undefined) wave(waveform.voice, laneTop.Voice, 28, "rgba(162,159,153,0.7)");

      for (const e of analysis.events) {
        if (e.timestamp_ms < t0 || e.timestamp_ms > t1) continue;
        const px = Math.round(x(e.timestamp_ms));
        const y = laneTop.Exhaust!;
        if (e.kind === "POP") {
          ctx.fillStyle = C.pop;
          ctx.fillRect(px, y, 2, 10);
        } else {
          ctx.fillStyle = C.straw;
          ctx.beginPath();
          ctx.moveTo(px - 4, y + 48);
          ctx.lineTo(px + 4, y + 48);
          ctx.lineTo(px, y + 41);
          ctx.fill();
        }
      }

      // Outside the clip, then trim brackets.
      const a = x(clip.start_ms);
      const b = x(clip.end_ms);
      ctx.fillStyle = C.dim;
      ctx.fillRect(0, RULER, a, h - RULER);
      ctx.fillRect(b, RULER, w - b, h - RULER);
      ctx.fillStyle = C.straw;
      for (const [px, dir] of [
        [a, 1],
        [b, -1],
      ] as const) {
        ctx.fillRect(px - (dir === 1 ? 0 : 3), RULER, 3, h - RULER);
        ctx.fillRect(dir === 1 ? px : px - 10, RULER, 10, 3);
        ctx.fillRect(dir === 1 ? px : px - 10, h - 3, 10, 3);
      }

      // Playhead.
      const p = Math.round(x(getTimeMs()));
      ctx.fillStyle = C.fg;
      ctx.fillRect(p, 8, 1, h - 8);
      ctx.beginPath();
      ctx.moveTo(p - 5, 2);
      ctx.lineTo(p + 6, 2);
      ctx.lineTo(p + 0.5, 9);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const msAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const [t0, t1] = range();
    return t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
  };

  return (
    <div className="flex h-full">
      <div className="w-[76px] shrink-0 pr-3 text-right text-[12px] text-muted" aria-hidden>
        <div style={{ height: RULER + GAP }} />
        {lanes.map((l) => (
          <div key={l.name} className="flex items-center justify-end" style={{ height: l.h, marginBottom: GAP }}>
            {l.name}
          </div>
        ))}
      </div>
      <canvas
        ref={ref}
        role="slider"
        aria-label="Clip timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(analysis.duration_ms)}
        aria-valuenow={Math.round(clip.start_ms)}
        aria-valuetext={`Clip from ${(clip.start_ms / 1000).toFixed(1)} s to ${(clip.end_ms / 1000).toFixed(1)} s`}
        tabIndex={0}
        className="h-full min-w-0 flex-1 cursor-crosshair"
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1_000 : 100;
          if (e.key === "ArrowLeft") onTrim(clip.start_ms - step, clip.end_ms - step);
          if (e.key === "ArrowRight") onTrim(clip.start_ms + step, clip.end_ms + step);
        }}
        onPointerDown={(e) => {
          const ms = msAt(e);
          const [t0, t1] = range();
          const pxPerMs = e.currentTarget.clientWidth / (t1 - t0);
          const near = (t: number) => Math.abs(ms - t) * pxPerMs < 10;
          const edge = near(clip.start_ms) ? "start" : near(clip.end_ms) ? "end" : null;
          if (edge) {
            drag.current = { edge, t0, t1 };
            e.currentTarget.setPointerCapture(e.pointerId);
          } else onSeek(ms);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const ms = Math.round(msAt(e));
          if (d.edge === "start") onTrim(Math.min(ms, clip.end_ms - 3_000), clip.end_ms);
          else onTrim(clip.start_ms, Math.max(ms, clip.start_ms + 3_000));
        }}
        onPointerUp={() => (drag.current = null)}
      />
    </div>
  );
}
