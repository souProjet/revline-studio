// Pure HUD renderer in 1080x1920 output space. The live overlay and the PNG exporter both
// call drawHud with the same inputs, so the exported MP4 matches the preview pixel-for-pixel.

import { SPECTRUM_BARS, TELEMETRY_HZ, type TelemetryFrame } from "./types";

export const HUD_W = 1080;
export const HUD_H = 1920;

/** TikTok/Reels UI: top tabs, right action rail, bottom caption + nav. Nothing drawn inside. */
export const SAFE = { top: 160, right: 140, bottom: 480, left: 60 } as const;

export type HudElement = "horizon" | "gMeter" | "miniMap" | "speed" | "spectrum";
export const HUD_ELEMENTS: HudElement[] = ["horizon", "gMeter", "miniMap", "speed", "spectrum"];

export interface HudOptions {
  fontFamily: string;
  show: Record<HudElement, boolean>;
  /** Drag offsets in output pixels, set by arranging the HUD on the viewer. */
  offset: Record<HudElement, { x: number; y: number }>;
  /** Per-element size, 0.7..1.4. */
  scale: Record<HudElement, number>;
  color: string;
  accent: string;
  alert: string;
  opacity: number;
  units: "KMH" | "MPH";
  /** Lean readout turns accent at this angle, alert at the next. */
  leanAccentDeg: number;
  leanAlertDeg: number;
  gMeterMax: number;
  trailMeters: number;
  /** null = never hide */
  redactAboveKmh: number | null;
  redactStyle: "REDACTED" | "BLUR";
}

export const DEFAULT_HUD: HudOptions = {
  fontFamily: "monospace",
  show: { horizon: true, gMeter: true, miniMap: true, speed: true, spectrum: true },
  offset: {
    horizon: { x: 0, y: 0 },
    gMeter: { x: 0, y: 0 },
    miniMap: { x: 0, y: 0 },
    speed: { x: 0, y: 0 },
    spectrum: { x: 0, y: 0 },
  },
  scale: { horizon: 1, gMeter: 1, miniMap: 1, speed: 1, spectrum: 1 },
  color: "#FFFFFF",
  accent: "#00F0FF",
  alert: "#FF2A54",
  opacity: 0.85,
  units: "KMH",
  leanAccentDeg: 35,
  leanAlertDeg: 45,
  gMeterMax: 1.2,
  trailMeters: 500,
  redactAboveKmh: 110,
  redactStyle: "REDACTED",
};

/** A contiguous 60 Hz window; `frames[0]` may start before the clip (GPS trail history). */
export interface TelemetryTrack {
  frames: TelemetryFrame[];
}

export function frameIndexAt(track: TelemetryTrack, tMs: number): number {
  const first = track.frames[0];
  if (!first) return -1;
  const i = Math.round(((tMs - first.timestamp_ms) * TELEMETRY_HZ) / 1000);
  return Math.max(0, Math.min(track.frames.length - 1, i));
}

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

// ---- layout ---------------------------------------------------------------------------

const COL_CX = (SAFE.left + (HUD_W - SAFE.right)) / 2;
const HZ_CY = SAFE.top + 140;
// Stack above the caption zone: G-meter + map, speed, spectrum.
const MID_Y = HUD_H - SAFE.bottom - 440;
const G_CX = SAFE.left + 120;
const G_R = 110;
const MAP_X = G_CX + G_R + 40;
const MAP_SIZE = 220;
const SPEED_X = SAFE.left;
const SPEED_Y = MID_Y + G_R + 150;
const SPEC_W = 600;
const SPEC_H = 90;
const SPEC_BASE = HUD_H - SAFE.bottom - 20;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Unscaled, unmoved footprint of each element. */
const BASE_BOX: Record<HudElement, Box> = {
  horizon: { x: COL_CX - 270, y: SAFE.top, w: 540, h: 290 },
  gMeter: { x: G_CX - G_R - 10, y: MID_Y - G_R - 10, w: 2 * G_R + 20, h: 2 * G_R + 70 },
  miniMap: { x: MAP_X, y: MID_Y + 10 - MAP_SIZE / 2, w: MAP_SIZE, h: MAP_SIZE },
  speed: { x: SPEED_X, y: SPEED_Y - 72, w: 420, h: 144 },
  spectrum: { x: COL_CX - SPEC_W / 2, y: SPEC_BASE - SPEC_H, w: SPEC_W, h: SPEC_H },
};

/** Where an element is drawn after scale (about its center) and drag offset. */
export function elementBox(o: HudOptions, el: HudElement): Box {
  const b = BASE_BOX[el];
  const s = o.scale[el];
  const off = o.offset[el];
  const w = b.w * s;
  const h = b.h * s;
  return { x: b.x + (b.w - w) / 2 + off.x, y: b.y + (b.h - h) / 2 + off.y, w, h };
}

/** Clamps a drag so the element stays inside the TikTok safe area. */
export function clampOffset(o: HudOptions, el: HudElement, x: number, y: number) {
  const b = BASE_BOX[el];
  const s = o.scale[el];
  const w = b.w * s;
  const h = b.h * s;
  const left = b.x + (b.w - w) / 2;
  const top = b.y + (b.h - h) / 2;
  return {
    x: Math.round(Math.max(SAFE.left - left, Math.min(HUD_W - SAFE.right - w - left, x))),
    y: Math.round(Math.max(SAFE.top - top, Math.min(HUD_H - SAFE.bottom - h - top, y))),
  };
}

// ---- drawing --------------------------------------------------------------------------

interface Ink {
  main: string;
  dim: string;
  accent: string;
  alert: string;
}

export function drawHud(ctx: CanvasRenderingContext2D, track: TelemetryTrack, tMs: number, o: HudOptions): void {
  ctx.clearRect(0, 0, HUD_W, HUD_H);
  const i = frameIndexAt(track, tMs);
  const f = track.frames[i];
  if (!f) return;
  const ink: Ink = {
    main: withAlpha(o.color, o.opacity),
    dim: withAlpha(o.color, o.opacity * 0.4),
    accent: withAlpha(o.accent, Math.min(1, o.opacity + 0.15)),
    alert: withAlpha(o.alert, Math.min(1, o.opacity + 0.15)),
  };
  const place = (el: HudElement, draw: () => void) => {
    if (!o.show[el]) return;
    const b = BASE_BOX[el];
    const s = o.scale[el];
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    ctx.save();
    ctx.translate(cx + o.offset[el].x, cy + o.offset[el].y);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    ctx.textBaseline = "middle";
    draw();
    ctx.restore();
  };
  place("horizon", () => drawHorizon(ctx, f, o, ink));
  place("gMeter", () => drawGMeter(ctx, track, i, o, ink));
  place("miniMap", () => drawMiniMap(ctx, track, i, o, ink));
  place("speed", () => drawSpeed(ctx, f, o, ink));
  place("spectrum", () => drawSpectrum(ctx, f, ink));
}

function font(o: HudOptions, px: number, weight = 600) {
  return `${weight} ${px}px ${o.fontFamily}`;
}

function drawHorizon(ctx: CanvasRenderingContext2D, f: TelemetryFrame, o: HudOptions, ink: Ink) {
  const cx = COL_CX;
  const cy = HZ_CY;
  const lean = f.lean_angle;
  const abs = Math.abs(lean);
  const tone = abs >= o.leanAlertDeg ? ink.alert : abs >= o.leanAccentDeg ? ink.accent : ink.main;

  ctx.strokeStyle = ink.dim;
  ctx.lineWidth = 3;
  for (const deg of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
    const a = ((deg - 90) * Math.PI) / 180;
    const r0 = deg % 30 === 0 ? 150 : 160;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + 40 + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * 172, cy + 40 + Math.sin(a) * 172);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - 260, cy + 40);
  ctx.lineTo(cx - 200, cy + 40);
  ctx.moveTo(cx + 200, cy + 40);
  ctx.lineTo(cx + 260, cy + 40);
  ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy + 40);
  ctx.rotate((lean * Math.PI) / 180);
  ctx.strokeStyle = tone;
  ctx.shadowColor = tone;
  ctx.shadowBlur = abs >= o.leanAccentDeg ? 18 : 0;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-180, 0);
  ctx.lineTo(-24, 0);
  ctx.lineTo(0, 14);
  ctx.lineTo(24, 0);
  ctx.lineTo(180, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -136);
  ctx.lineTo(-10, -118);
  ctx.lineTo(10, -118);
  ctx.closePath();
  ctx.fillStyle = tone;
  ctx.fill();
  ctx.restore();

  ctx.textAlign = "center";
  ctx.fillStyle = tone;
  ctx.font = font(o, 56, 800);
  const side = abs < 0.5 ? "" : lean > 0 ? " R" : " L";
  ctx.fillText(`${abs.toFixed(0)}°${side}`, cx, cy + 110);
}

function drawGMeter(ctx: CanvasRenderingContext2D, track: TelemetryTrack, i: number, o: HudOptions, ink: Ink) {
  const cy = MID_Y;
  const full = Math.max(0.5, o.gMeterMax);
  ctx.strokeStyle = ink.dim;
  ctx.lineWidth = 2;
  for (const g of [full / 2, full]) {
    ctx.beginPath();
    ctx.arc(G_CX, cy, (g / full) * G_R, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(G_CX - G_R, cy);
  ctx.lineTo(G_CX + G_R, cy);
  ctx.moveTo(G_CX, cy - G_R);
  ctx.lineTo(G_CX, cy + G_R);
  ctx.stroke();

  const pos = (f: TelemetryFrame) => {
    const k = G_R / full;
    const x = Math.max(-full, Math.min(full, f.g_lat));
    const y = Math.max(-full, Math.min(full, f.g_lon));
    return [G_CX + x * k, cy - y * k] as const;
  };
  for (let j = Math.max(0, i - 30); j <= i; j++) {
    const fj = track.frames[j];
    if (!fj) continue;
    const [x, y] = pos(fj);
    const age = (i - j) / 30;
    ctx.fillStyle = withAlpha(o.accent, (1 - age) * 0.5);
    ctx.beginPath();
    ctx.arc(x, y, 6 * (1 - age) + 2, 0, Math.PI * 2);
    ctx.fill();
  }
  const f = track.frames[i];
  if (!f) return;
  const [x, y] = pos(f);
  const mag = Math.hypot(f.g_lat, f.g_lon);
  ctx.fillStyle = mag >= 1 ? ink.alert : ink.accent;
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = ink.main;
  ctx.textAlign = "center";
  ctx.font = font(o, 34, 800);
  ctx.fillText(`${mag.toFixed(1)}G`, G_CX, cy + G_R + 36);
}

const EARTH_R = 6_371_000;

function drawMiniMap(ctx: CanvasRenderingContext2D, track: TelemetryTrack, i: number, o: HudOptions, ink: Ink) {
  const f = track.frames[i];
  if (!f || (f.lat === 0 && f.lon === 0)) return;
  const cosLat = Math.cos((f.lat * Math.PI) / 180);
  const toLocal = (g: TelemetryFrame) =>
    [(((g.lon - f.lon) * Math.PI) / 180) * EARTH_R * cosLat, -(((g.lat - f.lat) * Math.PI) / 180) * EARTH_R] as const;

  const pts: (readonly [number, number])[] = [[0, 0]];
  let dist = 0;
  let prev = pts[0]!;
  for (let j = i - 6; j >= 0 && dist < o.trailMeters; j -= 6) {
    const g = track.frames[j];
    if (!g || (g.lat === 0 && g.lon === 0)) break;
    const p = toLocal(g);
    dist += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    pts.push(p);
    prev = p;
  }
  if (pts.length < 3) return;

  const ref = pts[Math.min(3, pts.length - 1)]!;
  const heading = Math.atan2(-ref[0], -ref[1]);
  const scale = (MAP_SIZE * 0.45) / Math.max(120, ...pts.map((p) => Math.hypot(p[0], p[1])));
  const cx = MAP_X + MAP_SIZE / 2;
  const cy = MID_Y + 10;

  ctx.save();
  ctx.beginPath();
  ctx.rect(MAP_X, cy - MAP_SIZE / 2, MAP_SIZE, MAP_SIZE);
  ctx.clip();
  ctx.translate(cx, cy + MAP_SIZE * 0.25);
  ctx.rotate(heading);
  ctx.strokeStyle = ink.accent;
  ctx.shadowColor = ink.accent;
  ctx.shadowBlur = 14;
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((p, k) => (k ? ctx.lineTo(p[0] * scale, p[1] * scale) : ctx.moveTo(p[0] * scale, p[1] * scale)));
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = ink.main;
  ctx.beginPath();
  ctx.arc(cx, cy + MAP_SIZE * 0.25, 9, 0, Math.PI * 2);
  ctx.fill();
}

function drawSpeed(ctx: CanvasRenderingContext2D, f: TelemetryFrame, o: HudOptions, ink: Ink) {
  const mph = o.units === "MPH";
  const value = Math.round(mph ? f.speed_kmh * 0.621371 : f.speed_kmh);
  const redact = o.redactAboveKmh !== null && f.speed_kmh > o.redactAboveKmh;
  ctx.textAlign = "left";
  if (redact && o.redactStyle === "REDACTED") {
    ctx.fillStyle = ink.main;
    ctx.fillRect(SPEED_X, SPEED_Y - 44, 300, 88);
    ctx.fillStyle = "#000";
    ctx.font = font(o, 44, 800);
    ctx.fillText("[REDACTED]", SPEED_X + 14, SPEED_Y + 2);
  } else if (redact) {
    // Pixelate through a tiny canvas: deterministic in every engine, unlike ctx.filter.
    const small = document.createElement("canvas");
    small.width = 30;
    small.height = 12;
    const s = small.getContext("2d");
    if (s) {
      s.fillStyle = ink.main;
      s.font = font(o, 11, 800);
      s.textBaseline = "middle";
      s.fillText(String(value), 0, 6);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, SPEED_X, SPEED_Y - 72, 360, 144);
    }
  } else {
    ctx.fillStyle = ink.main;
    ctx.font = font(o, 128, 800);
    ctx.fillText(String(value), SPEED_X, SPEED_Y);
  }
  ctx.fillStyle = ink.dim;
  ctx.font = font(o, 30, 600);
  ctx.fillText(mph ? "MPH" : "KM/H", SPEED_X + (redact ? 380 : 250), SPEED_Y + 30);
}

function drawSpectrum(ctx: CanvasRenderingContext2D, f: TelemetryFrame, ink: Ink) {
  const x0 = COL_CX - SPEC_W / 2;
  const gap = 6;
  const bw = (SPEC_W - gap * (SPECTRUM_BARS - 1)) / SPECTRUM_BARS;
  for (let b = 0; b < SPECTRUM_BARS; b++) {
    const v = f.spectrum_bars[b] ?? 0;
    const h = Math.max(4, v * SPEC_H);
    ctx.fillStyle = v > 0.85 ? ink.alert : v > 0.6 ? ink.accent : ink.main;
    ctx.globalAlpha = 0.4 + 0.6 * v;
    ctx.fillRect(x0 + b * (bw + gap), SPEC_BASE - h, bw, h);
  }
  ctx.globalAlpha = 1;
}
