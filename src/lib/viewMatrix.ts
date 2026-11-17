// Port of telemetry::view_matrix + render_pipeline::view_ypr pitch offset. Keeps the WebGL
// preview geometrically identical to the ffmpeg v360 render. Axes: x right, y down, z fwd.

export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

const rad = (d: number) => (d * Math.PI) / 180;

function unit(v: [number, number, number]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]) || 1e-12;
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function viewMatrix(
  rollDeg: number,
  pitchDeg: number,
  rear: boolean,
  lockHorizon: boolean,
  pitchOffsetDeg: number,
): Mat3 {
  const r = lockHorizon ? rad(rollDeg) : 0;
  const p = lockHorizon ? rad(pitchDeg) : 0;
  const down: [number, number, number] = [-Math.sin(r) * Math.cos(p), Math.cos(r) * Math.cos(p), -Math.sin(p)];
  const fwd = unit([-down[0] * down[2], -down[1] * down[2], 1 - down[2] * down[2]]);
  const right: [number, number, number] = [
    down[1] * fwd[2] - down[2] * fwd[1],
    down[2] * fwd[0] - down[0] * fwd[2],
    down[0] * fwd[1] - down[1] * fwd[0],
  ];
  const s = rear ? -1 : 1;
  const rt = [right[0] * s, right[1] * s, right[2] * s];
  const fw = [fwd[0] * s, fwd[1] * s, fwd[2] * s];
  // columns rt, down, fw; then M · Rx(offset)
  const sn = Math.sin(rad(pitchOffsetDeg));
  const cs = Math.cos(rad(pitchOffsetDeg));
  const m: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row++) {
    const a = rt[row]!;
    const b = down[row]!;
    const c = fw[row]!;
    m[row * 3] = a;
    m[row * 3 + 1] = b * cs + c * sn;
    m[row * 3 + 2] = -b * sn + c * cs;
  }
  return m;
}

export interface Lens {
  /** tan of the half field of view across and down the frame. */
  tanX: number;
  tanY: number;
  /** Half the per-lens field of view, radians. */
  halfFov: number;
}

/** Field-of-view tangents for a frame, the field of view spanning its short side. */
export function lensFor(width: number, height: number, fovDeg: number, lensFovDeg: number): Lens {
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const a = width / height;
  return { tanX: a >= 1 ? t * a : t, tanY: a >= 1 ? t : t / a, halfFov: (lensFovDeg * Math.PI) / 360 };
}

/** View position (0..1 across and down) to a spot in a lens image. */
export function viewToLens(m: Mat3, x: number, y: number, k: Lens): { lens: "FRONT" | "REAR"; u: number; v: number } {
  const ray = unit([(x * 2 - 1) * k.tanX, (y * 2 - 1) * k.tanY, 1]);
  const r = [0, 1, 2].map((i) => m[i * 3]! * ray[0] + m[i * 3 + 1]! * ray[1] + m[i * 3 + 2]! * ray[2]) as [number, number, number];
  const front = r[2] >= 0;
  const l: [number, number, number] = front ? r : [-r[0], r[1], -r[2]];
  const rr = Math.acos(Math.max(-1, Math.min(1, l[2]))) / k.halfFov;
  const n = Math.hypot(l[0], l[1]) || 1e-9;
  return { lens: front ? "FRONT" : "REAR", u: (l[0] / n) * rr * 0.5 + 0.5, v: (l[1] / n) * rr * 0.5 + 0.5 };
}

/** Lens spot to a view position, or null when it is behind the view. */
export function lensToView(m: Mat3, lens: "FRONT" | "REAR", u: number, v: number, k: Lens): { x: number; y: number } | null {
  const px = u * 2 - 1;
  const py = v * 2 - 1;
  const rr = Math.hypot(px, py);
  const th = rr * k.halfFov;
  const s = rr > 1e-9 ? Math.sin(th) / rr : 0;
  const l: [number, number, number] = [px * s, py * s, Math.cos(th)];
  const r: [number, number, number] = lens === "FRONT" ? l : [-l[0], l[1], -l[2]];
  // M is orthonormal: the inverse is its transpose.
  const ray = [0, 1, 2].map((j) => m[j]! * r[0] + m[3 + j]! * r[1] + m[6 + j]! * r[2]) as [number, number, number];
  if (ray[2] <= 1e-6) return null;
  return { x: (ray[0] / ray[2] / k.tanX + 1) / 2, y: (ray[1] / ray[2] / k.tanY + 1) / 2 };
}
