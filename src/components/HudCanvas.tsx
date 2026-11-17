"use client";

import { useEffect, useRef, useState } from "react";
import {
  clampOffset,
  drawHud,
  elementBox,
  HUD_ELEMENTS,
  HUD_H,
  HUD_W,
  SAFE,
  type HudElement,
  type HudOptions,
  type TelemetryTrack,
} from "@/lib/hud";

interface Props {
  track: TelemetryTrack;
  /** Source time in ms of what the viewport currently shows (read every animation frame). */
  getTimeMs: () => number;
  options: HudOptions;
  showSafeZones: boolean;
  /** Arrange mode: elements can be dragged inside the safe area. */
  editable: boolean;
  onMove: (el: HudElement, offset: { x: number; y: number }) => void;
}

/**
 * Live 60 fps overlay. The backing store is the full 1080x1920 output raster scaled by CSS,
 * so geometry is identical to the exported PNG frames.
 */
export default function HudCanvas({ track, getTimeMs, options, showSafeZones, editable, onMove }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<HudElement | null>(null);
  const live = useRef({ track, getTimeMs, options, showSafeZones, editable, active });
  live.current = { track, getTimeMs, options, showSafeZones, editable, active };
  const drag = useRef<{ el: HudElement; startX: number; startY: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const tick = () => {
      const { track, getTimeMs, options, showSafeZones, editable, active } = live.current;
      drawHud(ctx, track, getTimeMs(), options);
      if (showSafeZones || editable) drawSafeZones(ctx);
      if (editable) drawHandles(ctx, options, active);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toHud = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * HUD_W, y: ((e.clientY - r.top) / r.height) * HUD_H };
  };

  return (
    <canvas
      ref={canvasRef}
      width={HUD_W}
      height={HUD_H}
      aria-label={editable ? "HUD layout. Drag elements to move them." : undefined}
      className={`absolute inset-0 h-full w-full ${editable ? "cursor-grab touch-none active:cursor-grabbing" : "pointer-events-none"}`}
      onPointerDown={(e) => {
        if (!editable) return;
        const p = toHud(e);
        const el = [...HUD_ELEMENTS].reverse().find((k) => {
          if (!options.show[k]) return false;
          const b = elementBox(options, k);
          return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
        });
        setActive(el ?? null);
        if (!el) return;
        drag.current = { el, startX: p.x, startY: p.y, ox: options.offset[el].x, oy: options.offset[el].y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const p = toHud(e);
        onMove(d.el, clampOffset(options, d.el, d.ox + p.x - d.startX, d.oy + p.y - d.startY));
      }}
      onPointerUp={() => (drag.current = null)}
    />
  );
}

function drawSafeZones(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = "rgba(255,42,84,0.12)";
  ctx.fillRect(0, 0, HUD_W, SAFE.top);
  ctx.fillRect(0, HUD_H - SAFE.bottom, HUD_W, SAFE.bottom);
  ctx.fillRect(HUD_W - SAFE.right, SAFE.top, SAFE.right, HUD_H - SAFE.top - SAFE.bottom);
  ctx.restore();
}

function drawHandles(ctx: CanvasRenderingContext2D, o: HudOptions, active: HudElement | null) {
  ctx.save();
  for (const el of HUD_ELEMENTS) {
    if (!o.show[el]) continue;
    const b = elementBox(o, el);
    ctx.strokeStyle = el === active ? "#e0b85c" : "rgba(235,232,227,0.45)";
    ctx.lineWidth = el === active ? 4 : 2;
    ctx.setLineDash(el === active ? [] : [12, 10]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.restore();
}
