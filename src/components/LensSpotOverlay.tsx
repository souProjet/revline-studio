"use client";

import { useEffect, useRef } from "react";
import type { LensSpot } from "@/lib/types";
import { lensToView, viewToLens, type Lens, type Mat3 } from "@/lib/viewMatrix";

interface Props {
  spot: LensSpot | null;
  /** Click-to-place mode. */
  marking: boolean;
  /** Whether the blur applies at a given source time (always, or only when too fast). */
  activeAt: (tMs: number) => boolean;
  viewAt: (tMs: number) => Mat3;
  getTimeMs: () => number;
  lens: Lens;
  onPlace: (spot: LensSpot) => void;
}

/**
 * Live preview of the dashboard blur: the lens spot is projected through the current view
 * every frame, so it follows the dashboard as the camera cuts and the horizon rotates.
 */
export default function LensSpotOverlay({ spot, marking, activeAt, viewAt, getTimeMs, lens, onPlace }: Props) {
  const disc = useRef<HTMLDivElement>(null);
  const live = useRef({ spot, marking, activeAt, viewAt, getTimeMs, lens });
  live.current = { spot, marking, activeAt, viewAt, getTimeMs, lens };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = disc.current;
      const { spot, marking, activeAt, viewAt, getTimeMs, lens } = live.current;
      if (el && el.parentElement) {
        const t = getTimeMs();
        const m = viewAt(t);
        const c = spot && lensToView(m, spot.lens, spot.u, spot.v, lens);
        const edge = spot && lensToView(m, spot.lens, spot.u + spot.radius, spot.v, lens);
        const show = !!c && (marking || activeAt(t));
        el.style.display = show ? "block" : "none";
        if (show && c) {
          const { width, height } = el.parentElement.getBoundingClientRect();
          const r = edge ? Math.max(8, Math.hypot((edge.x - c.x) * width, (edge.y - c.y) * height)) : 24;
          el.style.transform = `translate(${c.x * width - r}px, ${c.y * height - r}px)`;
          el.style.width = el.style.height = `${2 * r}px`;
          el.style.outline = marking ? "2px dashed #e0b85c" : "none";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`absolute inset-0 ${marking ? "cursor-crosshair" : "pointer-events-none"}`}
      aria-label={marking ? "Click the dashboard to place the blur" : undefined}
      onClick={(e) => {
        if (!marking) return;
        const b = e.currentTarget.getBoundingClientRect();
        const t = getTimeMs();
        const hit = viewToLens(viewAt(t), (e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height, lens);
        onPlace({ ...hit, radius: spot?.radius ?? 0.08 });
      }}
    >
      <div ref={disc} className="absolute left-0 top-0 hidden rounded-[22%] backdrop-blur-[14px]" style={{ background: "rgba(20,20,22,0.25)" }} />
    </div>
  );
}
