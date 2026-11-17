import { frameIndexAt, type TelemetryTrack } from "./hud";
import { TELEMETRY_HZ, type TelemetryFrame } from "./types";

/** Same rolling mean as `telemetry::horizon_at` (keeps preview and export aligned). */
export function horizonAt(track: TelemetryTrack, tMs: number, half: number): Pick<TelemetryFrame, "horizon_roll" | "horizon_pitch"> {
  const frames = track.frames;
  if (!frames.length) return { horizon_roll: 0, horizon_pitch: 0 };
  const i = frameIndexAt(track, tMs);
  if (half <= 0) {
    const f = frames[i];
    return { horizon_roll: f?.horizon_roll ?? 0, horizon_pitch: f?.horizon_pitch ?? 0 };
  }
  const lo = Math.max(0, i - half);
  const hi = Math.min(frames.length - 1, i + half);
  let roll = 0;
  let pitch = 0;
  for (let j = lo; j <= hi; j++) {
    const f = frames[j]!;
    roll += f.horizon_roll;
    pitch += f.horizon_pitch;
  }
  const n = hi - lo + 1;
  return { horizon_roll: roll / n, horizon_pitch: pitch / n };
}

export function stabiliseLabel(half: number): string {
  if (half <= 0) return "Off";
  const ms = Math.round(((half * 2 + 1) / TELEMETRY_HZ) * 1000);
  return `${ms} ms`;
}