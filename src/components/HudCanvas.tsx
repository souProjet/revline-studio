"use client";

import { useEffect, useRef, useState } from "react";
import {
  clampOffset,
  drawHud,
  elementBox,
  HUD_ELEMENTS,
  type HudElement,
  type HudLayout,
  type HudOptions,
  type TelemetryTrack,
} from "@/lib/hud";

interface Props {
  track: TelemetryTrack;
  /** Source time in ms of what the viewport currently shows (read every animation frame). */
  getTimeMs: () => number;
  options: HudOptions;
  layout: HudLayout;
  hideSpeedAbove: number | null;
  leanOffsetDeg: number;
  showSafeZones: boolean;
  /** Arrange mode: elements can be dragged inside the safe area. */
  editable: boolean;
  onMove: (el: HudElement, offset: { x: number; y: number }) => void;
}

/**
 * Live 60 fps overlay. The backing store is the base-size frame (1080 px short side) scaled
 * by CSS; the exporter draws the same layout at output size, so geometry matches.
 */
export default function HudCanvas({
  track,
  getTimeMs,
  options,
  layout,
  hideSpeedAbove,
  leanOffsetDeg,
  showSafeZones,
  editable,
  onMove,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<HudElement | null>(null);
  const live = useRef({ track, getTimeMs, options, layout, hideSpeedAbove, leanOffsetDeg, showSafeZones, editable, active });
  live.current = { track, getTimeMs, options, layout, hideSpeedAbove, leanOffsetDeg, showSafeZones, editable, active };
  const drag = useRef<{ el: HudElement; startX: number; startY: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const tick = () => {
      const { track, getTimeMs, options, layout, hideSpeedAbove, leanOffsetDeg, showSafeZones, editable, active } = live.current;
      drawHud(ctx, track, getTimeMs(), options, layout, hideSpeedAbove, leanOffsetDeg);
      if (showSafeZones || editable) drawSafeZones(ctx, layout);
      if (editable) drawHandles(ctx, options, layout, active);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toHud = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * layout.w, y: ((e.clientY - r.top) / r.height) * layout.h };
  };

  return (
    <canvas
      ref={canvasRef}
      width={layout.w}
      height={layout.h}
      aria-label={editable ? "HUD layout. Drag elements to move them." : undefined}
      className={`absolute inset-0 h-full w-full ${editable ? "cursor-grab touch-none active:cursor-grabbing" : "pointer-events-none"}`}
      onPointerDown={(e) => {
        if (!editable) return;
        const p = toHud(e);
        const el = [...HUD_ELEMENTS].reverse().find((k) => {
          if (!options.show[k]) return false;
          const b = elementBox(options, k, layout);
          return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
        });
        setActive(el ?? null);
        if (!el) return;
        const off = options.offset[layout.aspect][el];
        drag.current = { el, startX: p.x, startY: p.y, ox: off.x, oy: off.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const p = toHud(e);
        onMove(d.el, clampOffset(options, d.el, layout, d.ox + p.x - d.startX, d.oy + p.y - d.startY));
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}

function drawSafeZones(ctx: CanvasRenderingContext2D, l: HudLayout) {
  const { w, h, safe } = l;
  ctx.save();
  ctx.fillStyle = "rgba(255,42,84,0.12)";
  ctx.fillRect(0, 0, w, safe.top);
  ctx.fillRect(0, h - safe.bottom, w, safe.bottom);
  ctx.fillRect(0, safe.top, safe.left, h - safe.top - safe.bottom);
  ctx.fillRect(w - safe.right, safe.top, safe.right, h - safe.top - safe.bottom);
  ctx.restore();
}

function drawHandles(ctx: CanvasRenderingContext2D, o: HudOptions, l: HudLayout, active: HudElement | null) {
  ctx.save();
  for (const el of HUD_ELEMENTS) {
    if (!o.show[el]) continue;
    const b = elementBox(o, el, l);
    ctx.strokeStyle = el === active ? "#e0b85c" : "rgba(235,232,227,0.45)";
    ctx.lineWidth = el === active ? 4 : 2;
    ctx.setLineDash(el === active ? [] : [12, 10]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.restore();
}
