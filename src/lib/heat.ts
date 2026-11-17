// Titanium heat-tint ramp (GP3 exhaust bluing): bare Ti -> straw -> bronze -> violet -> blue.
// Interpolated in OKLab so the violet/blue end doesn't go muddy.

const STOPS = ["#8e9196", "#e0b85c", "#c97d3c", "#8a55b8", "#4a7be0"];

type Lab = [number, number, number];

function toLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function fromLinear(c: number) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function hexToOklab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255)) as Lab;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, A, B]: Lab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

const LAB = STOPS.map(hexToOklab);
const CACHE = Array.from({ length: 101 }, (_, i) => {
  const x = (i / 100) * (LAB.length - 1);
  const k = Math.min(LAB.length - 2, Math.floor(x));
  const t = x - k;
  const a = LAB[k]!;
  const b = LAB[k + 1]!;
  return oklabToRgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
});

/** t in 0..1 -> CSS color. */
export function heat(t: number): string {
  return CACHE[Math.round(Math.min(1, Math.max(0, t)) * 100)]!;
}

export const RPM_SCALE_MIN = 3_000;
export const RPM_SCALE_MAX = 10_500;
export const rpmHeat = (rpm: number) => (rpm - RPM_SCALE_MIN) / (RPM_SCALE_MAX - RPM_SCALE_MIN);
