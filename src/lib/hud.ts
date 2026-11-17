// Pure HUD renderer. The live overlay and the PNG exporter both call drawHud with the same
// inputs, so the exported MP4 matches the preview pixel-for-pixel.
//
// Elements are drawn in their portrait 1080x1920 design coordinates, then moved to a home
// position computed for the chosen aspect and scaled to the frame. Layout works at "base"
// size (1080 px on the short side); drawHud scales the whole canvas to the output size.

import { SPECTRUM_BARS, TELEMETRY_HZ, type TelemetryFrame } from "./types";

export type Aspect = "9:16" | "4:5" | "1:1" | "16:9";
export const ASPECTS: Aspect[] = ["9:16", "4:5", "1:1", "16:9"];

/** Frame size at 1080 px on the short side. */
const BASE: Record<Aspect, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "4:5": { w: 1080, h: 1350 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Margins kept free of HUD, at base size. 9:16 avoids the TikTok/Reels UI (top tabs, right
 * action rail, caption and nav); the others use plain title-safe margins.
 */
const SAFE: Record<Aspect, Insets> = {
  "9:16": { top: 160, right: 140, bottom: 480, left: 60 },
  "4:5": { top: 60, right: 60, bottom: 60, left: 60 },
  "1:1": { top: 60, right: 60, bottom: 60, left: 60 },
  "16:9": { top: 60, right: 96, bottom: 60, left: 96 },
};

export function aspectOf(width: number, height: number): Aspect {
  const r = width / height;
  return ASPECTS.reduce((a, b) => (Math.abs(BASE[b].w / BASE[b].h - r) < Math.abs(BASE[a].w / BASE[a].h - r) ? b : a));
}

/** Output size for an aspect with `short` px on the short side, both sides even. */
export function outputSize(aspect: Aspect, short: number) {
  const b = BASE[aspect];
  const k = short / 1080;
  const even = (v: number) => Math.round((v * k) / 2) * 2;
  return { width: even(b.w), height: even(b.h) };
}

export type HudElement = "horizon" | "gMeter" | "miniMap" | "speed" | "spectrum";
export const HUD_ELEMENTS: HudElement[] = ["horizon", "gMeter", "miniMap", "speed", "spectrum"];

export interface HudOptions {
  fontFamily: string;
  show: Record<HudElement, boolean>;
  /** Drag offsets per aspect in base pixels, set by arranging the HUD on the viewer. */
  offset: Record<Aspect, Record<HudElement, { x: number; y: number }>>;
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
  /** How the speed is hidden when riding above the privacy speed limit. */
  redactStyle: "REDACTED" | "BLUR";
}

export const DEFAULT_HUD: HudOptions = {
  fontFamily: "monospace",
  show: { horizon: true, gMeter: true, miniMap: true, speed: true, spectrum: true },
  offset: Object.fromEntries(
    ASPECTS.map((a) => [a, Object.fromEntries(HUD_ELEMENTS.map((el) => [el, { x: 0, y: 0 }]))]),
  ) as HudOptions["offset"],
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

// Portrait design coordinates every element is drawn in.
const REF_SAFE = SAFE["9:16"];
const COL_CX = (REF_SAFE.left + (1080 - REF_SAFE.right)) / 2;
const HZ_CY = REF_SAFE.top + 140;
// Stack above the caption zone: G-meter + map, speed, spectrum.
const MID_Y = 1920 - REF_SAFE.bottom - 440;
const G_CX = REF_SAFE.left + 120;
const G_R = 110;
const MAP_X = G_CX + G_R + 40;
const MAP_SIZE = 220;
const SPEED_X = REF_SAFE.left;
const SPEED_Y = MID_Y + G_R + 150;
const SPEC_W = 600;
const SPEC_H = 90;
const SPEC_BASE = 1920 - REF_SAFE.bottom - 20;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Footprint of each element in design coordinates. */
const REF_BOX: Record<HudElement, Box> = {
  horizon: { x: COL_CX - 270, y: REF_SAFE.top, w: 540, h: 290 },
  gMeter: { x: G_CX - G_R - 10, y: MID_Y - G_R - 10, w: 2 * G_R + 20, h: 2 * G_R + 70 },
  miniMap: { x: MAP_X, y: MID_Y + 10 - MAP_SIZE / 2, w: MAP_SIZE, h: MAP_SIZE },
  speed: { x: SPEED_X, y: SPEED_Y - 72, w: 420, h: 144 },
  spectrum: { x: COL_CX - SPEC_W / 2, y: SPEC_BASE - SPEC_H, w: SPEC_W, h: SPEC_H },
};

export interface HudLayout {
  aspect: Aspect;
  /** Base frame size. */
  w: number;
  h: number;
  safe: Insets;
  /** Element size relative to the portrait design, so smaller frames get a smaller HUD. */
  k: number;
  /** Top-left of each element's unscaled, unmoved box. */
  home: Record<HudElement, { x: number; y: number }>;
}

/**
 * Horizon at the top center; G-meter, map and speed stacked bottom-left; spectrum along the
 * bottom (centered when the frame is wide or tall enough, else bottom-right). Reproduces the
 * portrait design exactly at 9:16.
 */
export function hudLayout(aspect: Aspect): HudLayout {
  const { w, h } = BASE[aspect];
  const safe = SAFE[aspect];
  const k = Math.sqrt((w * h) / (1080 * 1920));
  const L = safe.left;
  const R = w - safe.right;
  const B = h - safe.bottom;
  const centered = aspect === "9:16" || aspect === "16:9";
  return {
    aspect,
    w,
    h,
    safe,
    k,
    home: {
      horizon: { x: (L + R) / 2 - (REF_BOX.horizon.w * k) / 2, y: safe.top },
      gMeter: { x: L, y: B - 560 * k },
      miniMap: { x: L + 270 * k, y: B - 540 * k },
      speed: { x: L, y: B - 252 * k },
      spectrum: { x: centered ? (L + R) / 2 - (SPEC_W * k) / 2 : R - SPEC_W * k, y: B - 110 * k },
    },
  };
}

/** Where an element is drawn after scale (about its center) and drag offset, in base pixels. */
export function elementBox(o: HudOptions, el: HudElement, l: HudLayout): Box {
  const r = REF_BOX[el];
  const home = l.home[el];
  const s = o.scale[el];
  const off = o.offset[l.aspect][el];
  const w = r.w * l.k * s;
  const h = r.h * l.k * s;
  return { x: home.x + (r.w * l.k - w) / 2 + off.x, y: home.y + (r.h * l.k - h) / 2 + off.y, w, h };
}

/** Clamps a drag so the element stays inside the safe area. */
export function clampOffset(o: HudOptions, el: HudElement, l: HudLayout, x: number, y: number) {
  const b = elementBox({ ...o, offset: { ...o.offset, [l.aspect]: { ...o.offset[l.aspect], [el]: { x: 0, y: 0 } } } }, el, l);
  return {
    x: Math.round(Math.max(l.safe.left - b.x, Math.min(l.w - l.safe.right - b.w - b.x, x))),
    y: Math.round(Math.max(l.safe.top - b.y, Math.min(l.h - l.safe.bottom - b.h - b.y, y))),
  };
}

// ---- drawing --------------------------------------------------------------------------

interface Ink {
  main: string;
  dim: string;
  accent: string;
  alert: string;
}

/**
 * Draws onto a canvas of any size with the layout's aspect; it is scaled to fill it.
 * `hideSpeedAbove`: km/h above which the speed readout is hidden, null to always show it.
 */
export function drawHud(
  ctx: CanvasRenderingContext2D,
  track: TelemetryTrack,
  tMs: number,
  o: HudOptions,
  l: HudLayout,
  hideSpeedAbove: number | null,
  leanOffsetDeg = 0,
): void {
  const px = ctx.canvas.width / l.w;
  ctx.setTransform(px, 0, 0, px, 0, 0);
  ctx.clearRect(0, 0, l.w, l.h);
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
    const r = REF_BOX[el];
    const b = elementBox(o, el, l);
    const s = o.scale[el] * l.k;
    ctx.save();
    ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
    ctx.scale(s, s);
    ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    ctx.textBaseline = "middle";
    draw();
    ctx.restore();
  };
  place("horizon", () => drawHorizon(ctx, f, o, ink, leanOffsetDeg));
  place("gMeter", () => drawGMeter(ctx, track, i, o, ink));
  place("miniMap", () => drawMiniMap(ctx, track, i, o, ink));
  place("speed", () => drawSpeed(ctx, f, o, ink, hideSpeedAbove));
  place("spectrum", () => drawSpectrum(ctx, f, ink));
}

function font(o: HudOptions, px: number, weight = 600) {
  return `${weight} ${px}px ${o.fontFamily}`;
}

function drawHorizon(ctx: CanvasRenderingContext2D, f: TelemetryFrame, o: HudOptions, ink: Ink, leanOffsetDeg: number) {
  const cx = COL_CX;
  const cy = HZ_CY;
  const lean = f.lean_angle + leanOffsetDeg;
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

function drawSpeed(ctx: CanvasRenderingContext2D, f: TelemetryFrame, o: HudOptions, ink: Ink, hideAbove: number | null) {
  const mph = o.units === "MPH";
  const value = Math.round(mph ? f.speed_kmh * 0.621371 : f.speed_kmh);
  const redact = hideAbove !== null && f.speed_kmh > hideAbove;
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
