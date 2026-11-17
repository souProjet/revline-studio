"use client";

import { aspectOf, DEFAULT_HUD, HUD_ELEMENTS, outputSize, type Aspect, type HudElement, type HudOptions } from "@/lib/hud";
import { bitrateMbps, DEFAULT_SETTINGS, DEFAULT_SOUND } from "@/lib/settings";
import type { Quality, RenderSettings, SoundSettings, SystemInfo, VideoCodec } from "@/lib/types";
import { Button, ColorField, Section, Segmented, Slider, Switch, TextField } from "./ui";

const ELEMENT_NAME: Record<HudElement, string> = {
  horizon: "Horizon and lean",
  gMeter: "G-force",
  miniMap: "GPS trace",
  speed: "Speed",
  spectrum: "Exhaust spectrum",
};

const CODEC_NAME: Record<VideoCodec, string> = { H264: "H.264", HEVC: "HEVC", AV1: "AV1" };

const FORMAT_USE: Record<Aspect, string> = {
  "9:16": "Portrait for TikTok, Reels and Shorts",
  "4:5": "Instagram feed",
  "1:1": "Square for feeds",
  "16:9": "Landscape for YouTube",
};

const RESOLUTIONS: [string, string][] = [
  ["720", "720p"],
  ["1080", "1080p"],
  ["1440", "1440p"],
  ["2160", "4K"],
];

interface Props {
  settings: RenderSettings;
  setSettings: (f: (s: RenderSettings) => RenderSettings) => void;
  hud: HudOptions;
  setHud: (f: (h: HudOptions) => HudOptions) => void;
  system: SystemInfo | null;
  arranging: boolean;
  setArranging: (v: boolean) => void;
  safeZones: boolean;
  setSafeZones: (v: boolean) => void;
  outDir: string;
  setOutDir: (v: string) => void;
  hasVoice: boolean;
}

const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);

export default function Inspector(p: Props) {
  const { settings: s, hud } = p;
  const set = <K extends keyof RenderSettings>(k: K) => (v: RenderSettings[K]) => p.setSettings((x) => ({ ...x, [k]: v }));
  const snd = <K extends keyof SoundSettings>(k: K) => (v: SoundSettings[K]) => p.setSettings((x) => ({ ...x, sound: { ...x.sound, [k]: v } }));
  const setH = <K extends keyof HudOptions>(k: K) => (v: HudOptions[K]) => p.setHud((h) => ({ ...h, [k]: v }));
  const per = <K extends "show" | "scale">(k: K, el: HudElement) => (v: HudOptions[K][HudElement]) =>
    p.setHud((h) => ({ ...h, [k]: { ...h[k], [el]: v } }));
  const failed = (p.system?.encoders ?? []).filter((e) => !e.ok).map((e) => e.codec);
  const voiceOnly = p.hasVoice ? undefined : "No voice track in this project";

  return (
    <>
      <Section title="Camera" collapsible>
        <Segmented
          label="Camera"
          value={s.camera_mode}
          options={[
            ["FRONT", "Road"],
            ["REAR", "Rider"],
            ["AUTO", "Auto"],
          ]}
          onChange={set("camera_mode")}
        />
        <Switch label="Horizon Lock" hint="Road stays level while the bike leans" on={s.horizon_lock} set={set("horizon_lock")} />
        <Slider label="Field of view" unit="°" min={60} max={110} value={s.h_fov_deg} set={set("h_fov_deg")} />
        <Slider label="Tilt" unit="°" min={-25} max={10} value={s.pitch_offset_deg} set={set("pitch_offset_deg")} />
        <Slider label="Lens field of view" unit="°" min={185} max={215} value={s.lens_fov_deg} set={set("lens_fov_deg")} />
        <p className="text-[12px] text-muted">Adjust the lens field of view if the stitch line between the two lenses doesn&apos;t line up.</p>
      </Section>

      <Section title="Look" collapsible>
        <TextField label="LUT (.cube)" value={s.lut_path ?? ""} placeholder="Moody Asphalt LUT" onChange={(v) => set("lut_path")(v || null)} />
        <Slider label="Vignette" min={0} max={1} step={0.05} value={s.vignette} format={(v) => (v === 0 ? "Off" : `${Math.round(v * 100)} %`)} set={set("vignette")} />
      </Section>

      <Section title="HUD" collapsible aside={<button type="button" className="hover:text-fg" onClick={() => p.setHud((h) => ({ ...DEFAULT_HUD, fontFamily: h.fontFamily }))}>Reset</button>}>
        <Switch label="Show HUD" on={s.hud} set={set("hud")} />
        {s.hud && (
          <>
            <Switch label="Arrange on the video" hint="Drag elements; they stay inside the format's safe area" on={p.arranging} set={p.setArranging} />
            <div className="space-y-2 rounded-[3px] bg-surround p-3">
              {HUD_ELEMENTS.map((el) => (
                <div key={el} className="space-y-1.5">
                  <Switch label={ELEMENT_NAME[el]} on={hud.show[el]} set={per("show", el)} />
                  {hud.show[el] && (
                    <Slider label="Size" min={0.7} max={1.4} step={0.05} value={hud.scale[el]} format={(v) => `${Math.round(v * 100)} %`} set={per("scale", el)} />
                  )}
                </div>
              ))}
            </div>
            <ColorField label="Main color" value={hud.color} set={setH("color")} />
            <ColorField label="Accent" value={hud.accent} set={setH("accent")} />
            <ColorField label="Warning" value={hud.alert} set={setH("alert")} />
            <Slider label="Opacity" min={0.3} max={1} step={0.05} value={hud.opacity} format={(v) => `${Math.round(v * 100)} %`} set={setH("opacity")} />
            <Segmented
              label="Units"
              value={hud.units}
              options={[
                ["KMH", "km/h"],
                ["MPH", "mph"],
              ]}
              onChange={setH("units")}
            />
            <Slider label="Lean accent from" unit="°" min={20} max={50} value={hud.leanAccentDeg} set={(v) => p.setHud((h) => ({ ...h, leanAccentDeg: v, leanAlertDeg: Math.max(v + 1, h.leanAlertDeg) }))} />
            <Slider label="Lean warning from" unit="°" min={hud.leanAccentDeg + 1} max={60} value={hud.leanAlertDeg} set={setH("leanAlertDeg")} />
            <Slider label="G-force scale" min={0.8} max={2} step={0.1} value={hud.gMeterMax} format={(v) => `${v.toFixed(1)} G`} set={setH("gMeterMax")} />
            <Segmented
              label="GPS trace length"
              value={String(hud.trailMeters)}
              options={[
                ["250", "250 m"],
                ["500", "500 m"],
                ["1000", "1 km"],
              ]}
              onChange={(v) => setH("trailMeters")(Number(v))}
            />
            <Switch label="Hide high speeds" on={hud.redactAboveKmh !== null} set={(v) => setH("redactAboveKmh")(v ? 110 : null)} />
            {hud.redactAboveKmh !== null && (
              <>
                <Slider label="Hide above" unit=" km/h" min={50} max={200} step={5} value={hud.redactAboveKmh} set={setH("redactAboveKmh")} />
                <Segmented
                  label="Hide style"
                  value={hud.redactStyle}
                  options={[
                    ["REDACTED", "Redacted bar"],
                    ["BLUR", "Blur"],
                  ]}
                  onChange={setH("redactStyle")}
                />
              </>
            )}
            <Switch label="Show safe zones" hint="Preview only, never rendered" on={p.safeZones} set={p.setSafeZones} />
          </>
        )}
      </Section>

      <Section title="Sound" collapsible aside={<button type="button" className="hover:text-fg" onClick={() => p.setSettings((x) => ({ ...x, sound: DEFAULT_SOUND }))}>Reset</button>}>
        <Slider label="Exhaust level" min={-12} max={12} step={0.5} value={s.sound.exhaust_gain_db} format={db} set={snd("exhaust_gain_db")} />
        <Switch label="Dominator GP3 EQ" hint="Cuts wind rumble, adds chest punch, tames redline rasp" on={s.sound.exhaust_eq} set={snd("exhaust_eq")} />
        {s.sound.exhaust_eq && (
          <div className="space-y-2 rounded-[3px] bg-surround p-3">
            <Slider label="Wind cut below" min={30} max={150} step={5} value={s.sound.highpass_hz} format={hz} set={snd("highpass_hz")} />
            <Slider label="Punch at" min={70} max={250} step={5} value={s.sound.body_hz} format={hz} set={snd("body_hz")} />
            <Slider label="Punch" min={-3} max={6} step={0.5} value={s.sound.body_gain_db} format={db} set={snd("body_gain_db")} />
            <Slider label="Rasp at" min={2000} max={6000} step={100} value={s.sound.rasp_hz} format={hz} set={snd("rasp_hz")} />
            <Slider label="Rasp" min={-8} max={3} step={0.5} value={s.sound.rasp_gain_db} format={db} set={snd("rasp_gain_db")} />
          </div>
        )}
        <div className={p.hasVoice ? "space-y-3" : "space-y-3 opacity-50"} title={voiceOnly}>
          <Slider label="Voice level" min={-12} max={12} step={0.5} value={s.sound.voice_gain_db} format={db} set={snd("voice_gain_db")} disabled={!p.hasVoice} />
          <Slider
            label="Wind and helmet noise removal"
            min={0}
            max={40}
            value={s.sound.voice_denoise_db}
            format={(v) => (v === 0 ? "Off" : `${v} dB`)}
            set={snd("voice_denoise_db")}
            disabled={!p.hasVoice || s.sound.voice_denoise_model !== null}
          />
          <TextField
            label="Noise model (.rnnn, replaces the slider)"
            value={s.sound.voice_denoise_model ?? ""}
            placeholder="Optional"
            onChange={(v) => snd("voice_denoise_model")(v || null)}
          />
          <Switch label="Lower exhaust when you talk" on={s.sound.ducking} set={snd("ducking")} />
          {s.sound.ducking && <Slider label="Lower by" unit=" dB" min={1} max={12} step={0.5} value={s.sound.ducking_db} set={snd("ducking_db")} disabled={!p.hasVoice} />}
        </div>
        <Segmented
          label="Loudness target"
          value={String(s.sound.loudness_lufs)}
          options={[
            ["-14", "−14 LUFS TikTok"],
            ["-16", "−16 YouTube"],
            ["-11", "−11 Loud"],
          ]}
          onChange={(v) => snd("loudness_lufs")(Number(v))}
        />
        <Slider label="Peak ceiling" min={-3} max={0} step={0.1} value={s.sound.true_peak_db} format={(v) => `${v.toFixed(1)} dBTP`} set={snd("true_peak_db")} />
      </Section>

      <Section title="Export" collapsible>
        <TextField label="Save to" value={p.outDir} placeholder="Next to the recording" onChange={p.setOutDir} />
        <OutputFormat settings={s} setSettings={p.setSettings} />
        <Segmented
          label="Codec"
          value={s.codec}
          options={(["H264", "HEVC", "AV1"] as VideoCodec[]).map((c) => [c, CODEC_NAME[c]])}
          disabled={failed}
          onChange={set("codec")}
        />
        <Switch label="Decode on the GPU" hint="Frees the CPU for reprojection" on={s.hwaccel_decode} set={set("hwaccel_decode")} />
        <Hardware system={p.system} />
        <Button variant="ghost" className="-ml-3.5" onClick={() => p.setSettings(() => DEFAULT_SETTINGS)}>
          Reset all render settings
        </Button>
      </Section>
    </>
  );
}

function OutputFormat({ settings: s, setSettings }: Pick<Props, "settings" | "setSettings">) {
  const aspect = aspectOf(s.width, s.height);
  const short = Math.min(s.width, s.height);
  const size = (a: Aspect, px: number) => setSettings((x) => ({ ...x, ...outputSize(a, px) }));
  const mbps = bitrateMbps(s);
  return (
    <>
      <div className="space-y-1.5">
        <Segmented
          label="Format"
          value={aspect}
          options={(["9:16", "4:5", "1:1", "16:9"] as Aspect[]).map((a) => [a, a])}
          onChange={(a) => size(a, short)}
        />
        <p className="text-[12px] text-muted">{FORMAT_USE[aspect]}</p>
      </div>
      <Segmented label="Resolution" value={String(short)} options={RESOLUTIONS} onChange={(v) => size(aspect, Number(v))} />
      <Segmented
        label="Frame rate"
        value={String(s.fps)}
        options={[
          ["30", "30 fps"],
          ["60", "60 fps"],
        ]}
        onChange={(v) => setSettings((x) => ({ ...x, fps: Number(v) }))}
      />
      <Segmented
        label="Quality"
        value={s.quality}
        options={[
          ["STANDARD", "Standard"],
          ["HIGH", "High"],
          ["MAX", "Maximum"],
        ] as [Quality, string][]}
        onChange={(v) => setSettings((x) => ({ ...x, quality: v }))}
      />
      <p className="font-mono text-[12px] text-muted">
        {s.width} × {s.height} · {s.fps} fps · {mbps} Mb/s · about {Math.round((mbps * 60) / 8 + 2.4)} MB per minute
      </p>
      {short > 1080 && (
        <p className="text-[12px] text-muted">
          Above 1080p the 360° reprojection runs on the CPU and renders several times slower. TikTok and Instagram re-encode to 1080p.
        </p>
      )}
    </>
  );
}

function Hardware({ system }: { system: SystemInfo | null }) {
  if (!system) return <p className="text-[12px] text-muted">Checking ffmpeg and the GPU…</p>;
  return (
    <div className="space-y-1.5 rounded-[3px] bg-surround p-3 text-[12px]">
      <Row label="GPU" value={system.gpu ? `${system.gpu.name}, ${(system.gpu.memory_total_mb / 1024).toFixed(0)} GB` : "No NVIDIA GPU found"} ok={!!system.gpu || system.hwaccel === "videotoolbox"} />
      {system.gpu && <Row label="Driver" value={system.gpu.driver} ok />}
      <Row label="ffmpeg" value={system.ffmpeg ?? "Not found on PATH"} ok={!!system.ffmpeg} />
      <Row label="GPU decode" value={system.hwaccel_ok ? system.hwaccel : `${system.hwaccel} unavailable`} ok={system.hwaccel_ok} />
      {system.encoders.map((e) => (
        <div key={e.codec}>
          <Row label={CODEC_NAME[e.codec]} value={e.ok ? (e.encoder ?? "") : "Not available"} ok={e.ok} />
          {!e.ok && e.detail && <p className="mt-0.5 break-words pl-[72px] text-faint">{e.detail}</p>}
        </div>
      ))}
      <Row label="CPU" value={`${system.cpu_threads} threads`} ok />
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="w-[60px] shrink-0 text-muted">{label}</span>
      <span className={`flex min-w-0 items-center gap-1.5 ${ok ? "text-fg" : "text-muted"}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-straw" : "border border-muted"}`} aria-hidden />
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}
