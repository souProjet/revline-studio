"use client";

import { useEffect, useState } from "react";
import { DEFAULT_HUD, type HudOptions } from "./hud";
import type { RenderSettings, SoundSettings } from "./types";

export const DEFAULT_SOUND: SoundSettings = {
  exhaust_eq: true,
  highpass_hz: 65,
  body_hz: 120,
  body_gain_db: 2,
  rasp_hz: 3500,
  rasp_gain_db: -2.5,
  exhaust_gain_db: 0,
  voice_gain_db: 0,
  voice_denoise_db: 18,
  voice_denoise_model: null,
  ducking: true,
  ducking_db: 5,
  loudness_lufs: -14,
  true_peak_db: -1,
};

export const DEFAULT_SETTINGS: RenderSettings = {
  camera_mode: "AUTO",
  horizon_lock: true,
  lut_path: null,
  vignette: 0.5,
  hud: true,
  codec: "H264",
  bitrate_mbps: 25,
  hwaccel_decode: true,
  lens_fov_deg: 200,
  h_fov_deg: 80,
  pitch_offset_deg: -8,
  sound: DEFAULT_SOUND,
};

export { DEFAULT_HUD };
export type { HudOptions };

/**
 * State remembered between sessions on this machine. Storage may be unavailable (private
 * mode, cleared data); the app then simply starts from the defaults. Stored values are
 * merged over the defaults so fields added later get their default.
 */
export function usePersistentState<T extends object>(key: string, defaults: T) {
  const [value, setValue] = useState<T>(defaults);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setValue(deepMerge(defaults, JSON.parse(raw) as Partial<T>));
    } catch {
      /* start from defaults */
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* not persisted this session */
    }
  }, [key, value, loaded]);
  return [value, setValue] as const;
}

function deepMerge<T>(base: T, over: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base) || typeof over !== "object" || over === null) {
    return (over === undefined || (over !== null && typeof over !== typeof base) ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (k in out) out[k] = deepMerge(out[k], v);
  }
  return out as T;
}
