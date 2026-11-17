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
