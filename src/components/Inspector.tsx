"use client";

import { useState } from "react";
import { DEFAULT_HUD, HUD_ELEMENTS, type HudElement, type HudOptions } from "@/lib/hud";
import { DEFAULT_PRIVACY, DEFAULT_SETTINGS, DEFAULT_SOUND } from "@/lib/settings";
import { stabiliseLabel } from "@/lib/telemetryView";
import type { BlurWhen, PrivacySettings, RenderSettings, SoundSettings } from "@/lib/types";
import { Button, ColorField, Field, Group, Segmented, Slider, Switch, Tabs, TextField } from "./ui";

const ELEMENT_NAME: Record<HudElement, string> = {
  horizon: "Horizon and lean",
  gMeter: "G-force",
  miniMap: "GPS trace",
  speed: "Speed",
  spectrum: "Exhaust spectrum",
};

type Tab = "view" | "hud" | "sound" | "privacy";

interface Props {
  settings: RenderSettings;
  setSettings: (f: (s: RenderSettings) => RenderSettings) => void;
  hud: HudOptions;
  setHud: (f: (h: HudOptions) => HudOptions) => void;
  arranging: boolean;
  setArranging: (v: boolean) => void;
  marking: boolean;
  setMarking: (v: boolean) => void;
  safeZones: boolean;
  setSafeZones: (v: boolean) => void;
  hasVoice: boolean;
}

const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const reset = (onClick: () => void) => (
  <button type="button" className="hover:text-fg" onClick={onClick}>
    Reset
  </button>
);

/** Per-look settings, one concern per tab so nothing needs a long scroll. */
export default function Inspector(p: Props) {
  const [tab, setTab] = useState<Tab>("view");
  const pv = p.settings.privacy;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs
        label="Clip settings"
        value={tab}
        onChange={setTab}
        tabs={[
          ["view", "View"],
          ["hud", "HUD", p.settings.hud],
          ["sound", "Sound"],
          ["privacy", "Privacy", pv.hide_hud_speed || pv.dashboard !== "OFF" || pv.plates],
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "view" && <ViewTab {...p} />}
        {tab === "hud" && <HudTab {...p} />}
        {tab === "sound" && <SoundTab {...p} />}
        {tab === "privacy" && <PrivacyTab {...p} />}
      </div>
    </div>
  );
}

function ViewTab({ settings: s, setSettings }: Props) {
  const set = <K extends keyof RenderSettings>(k: K) => (v: RenderSettings[K]) => setSettings((x) => ({ ...x, [k]: v }));
  return (
    <>
      <Group title="Camera">
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
        <p className="text-[12px] text-muted">
          {s.camera_mode === "AUTO"
            ? "Cuts to the rider on shifts and pops, back to the road for corners."
            : s.camera_mode === "REAR"
              ? "Faces you for the whole clip."
              : "Looks down the road for the whole clip."}
        </p>
        <Switch label="Horizon Lock" hint="Road stays level while the bike leans" on={s.horizon_lock} set={set("horizon_lock")} />
        <Slider
          label="Horizon stabilization"
          min={0}
          max={24}
          step={1}
          value={s.horizon_stabilize}
          format={stabiliseLabel}
          set={set("horizon_stabilize")}
          disabled={!s.horizon_lock}
        />
        <p className="text-[12px] text-muted">
          {s.horizon_lock
            ? "Smooths engine vibration on the gyro. Increase if the preview still shakes; lower if corners feel sluggish."
            : "Enable Horizon Lock to use stabilization."}
        </p>
        <Slider
          label="Field of view (zoom)"
          unit="°"
          min={55}
          max={120}
          value={s.h_fov_deg}
          set={set("h_fov_deg")}
        />
        <p className="text-[12px] text-muted">Smaller = tighter crop, larger = wider angle.</p>
      </Group>
      <Group title="Calibration" aside={reset(() => setSettings((x) => ({ ...x, roll_offset_deg: 0, pitch_offset_deg: DEFAULT_SETTINGS.pitch_offset_deg, lean_offset_deg: 0 })))}>
        <Slider
          label="Horizon roll offset"
          unit="°"
          min={-20}
          max={20}
          step={0.5}
          value={s.roll_offset_deg}
          set={set("roll_offset_deg")}
        />
        <p className="text-[12px] text-muted">Level the image if the road always looks tilted left or right.</p>
        <Slider label="View tilt" unit="°" min={-30} max={15} step={0.5} value={s.pitch_offset_deg} set={set("pitch_offset_deg")} />
        <p className="text-[12px] text-muted">Negative tilts the frame down toward the road.</p>
        <Slider label="Lean offset" unit="°" min={-20} max={20} step={0.5} value={s.lean_offset_deg} set={set("lean_offset_deg")} />
        <p className="text-[12px] text-muted">Corrects the lean gauge on the HUD; does not rotate the video.</p>
      </Group>
      <Group title="Look">
        <TextField label="Color LUT (.cube)" value={s.lut_path ?? ""} placeholder="None" onChange={(v) => set("lut_path")(v || null)} />
        <Slider label="Vignette" min={0} max={1} step={0.05} value={s.vignette} format={(v) => (v === 0 ? "Off" : `${Math.round(v * 100)} %`)} set={set("vignette")} />
      </Group>
      <Group title="Lens">
        <Slider label="Lens field of view" unit="°" min={185} max={215} value={s.lens_fov_deg} set={set("lens_fov_deg")} />
        <p className="text-[12px] text-muted">Adjust it if the stitch line between the two lenses doesn&apos;t line up.</p>
      </Group>
    </>
  );
}

function HudTab(p: Props) {
  const { settings: s, hud } = p;
  const setH = <K extends keyof HudOptions>(k: K) => (v: HudOptions[K]) => p.setHud((h) => ({ ...h, [k]: v }));
  const per = <K extends "show" | "scale">(k: K, el: HudElement) => (v: HudOptions[K][HudElement]) =>
    p.setHud((h) => ({ ...h, [k]: { ...h[k], [el]: v } }));
  return (
    <>
      <Group title="Overlay" aside={reset(() => p.setHud((h) => ({ ...DEFAULT_HUD, fontFamily: h.fontFamily })))}>
        <Switch label="Show HUD" on={s.hud} set={(v) => p.setSettings((x) => ({ ...x, hud: v }))} />
        {s.hud && (
          <>
            <Button variant={p.arranging ? "primary" : "secondary"} className="w-full" onClick={() => p.setArranging(!p.arranging)}>
              {p.arranging ? "Done arranging" : "Arrange on the video"}
            </Button>
            <Switch label="Show safe zones" hint="Preview only, never rendered" on={p.safeZones} set={p.setSafeZones} />
          </>
        )}
      </Group>
      {s.hud && (
        <>
          <Group title="Elements">
            {HUD_ELEMENTS.map((el) => (
              <div key={el} className="space-y-1.5">
                <Switch label={ELEMENT_NAME[el]} on={hud.show[el]} set={per("show", el)} />
                {hud.show[el] && (
                  <Slider label="Size" min={0.7} max={1.4} step={0.05} value={hud.scale[el]} format={(v) => `${Math.round(v * 100)} %`} set={per("scale", el)} />
                )}
              </div>
            ))}
          </Group>
          <Group title="Style">
            <ColorField label="Main color" value={hud.color} set={setH("color")} />
            <ColorField label="Accent" value={hud.accent} set={setH("accent")} />
            <ColorField label="Warning" value={hud.alert} set={setH("alert")} />
            <Slider label="Opacity" min={0.3} max={1} step={0.05} value={hud.opacity} format={(v) => `${Math.round(v * 100)} %`} set={setH("opacity")} />
          </Group>
          <Group title="Readouts">
            <Field label="Units">
              <Segmented
                label="Units"
                value={hud.units}
                options={[
                  ["KMH", "km/h"],
                  ["MPH", "mph"],
                ]}
                onChange={setH("units")}
              />
            </Field>
            <Slider
              label="Lean accent from"
              unit="°"
              min={20}
              max={50}
              value={hud.leanAccentDeg}
              set={(v) => p.setHud((h) => ({ ...h, leanAccentDeg: v, leanAlertDeg: Math.max(v + 1, h.leanAlertDeg) }))}
            />
            <Slider label="Lean warning from" unit="°" min={hud.leanAccentDeg + 1} max={60} value={hud.leanAlertDeg} set={setH("leanAlertDeg")} />
            <Slider label="G-force scale" min={0.8} max={2} step={0.1} value={hud.gMeterMax} format={(v) => `${v.toFixed(1)} G`} set={setH("gMeterMax")} />
            <Field label="GPS trace length">
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
            </Field>
          </Group>
        </>
      )}
    </>
  );
}

function SoundTab(p: Props) {
  const s = p.settings;
  const snd = <K extends keyof SoundSettings>(k: K) => (v: SoundSettings[K]) => p.setSettings((x) => ({ ...x, sound: { ...x.sound, [k]: v } }));
  return (
    <>
      <Group title="Exhaust" aside={reset(() => p.setSettings((x) => ({ ...x, sound: DEFAULT_SOUND })))}>
        <Slider label="Level" min={-12} max={12} step={0.5} value={s.sound.exhaust_gain_db} format={db} set={snd("exhaust_gain_db")} />
        <Switch label="Exhaust EQ" hint="Cuts wind rumble, adds chest punch, tames redline rasp" on={s.sound.exhaust_eq} set={snd("exhaust_eq")} />
        {s.sound.exhaust_eq && (
          <>
            <Slider label="Wind cut below" min={30} max={150} step={5} value={s.sound.highpass_hz} format={hz} set={snd("highpass_hz")} />
            <Slider label="Punch at" min={70} max={250} step={5} value={s.sound.body_hz} format={hz} set={snd("body_hz")} />
            <Slider label="Punch" min={-3} max={6} step={0.5} value={s.sound.body_gain_db} format={db} set={snd("body_gain_db")} />
            <Slider label="Rasp at" min={2000} max={6000} step={100} value={s.sound.rasp_hz} format={hz} set={snd("rasp_hz")} />
            <Slider label="Rasp" min={-8} max={3} step={0.5} value={s.sound.rasp_gain_db} format={db} set={snd("rasp_gain_db")} />
          </>
        )}
      </Group>
      <Group title="Voice" aside={p.hasVoice ? undefined : "No voice track"}>
        <div className={p.hasVoice ? "space-y-3" : "space-y-3 opacity-50"}>
          <Slider label="Level" min={-12} max={12} step={0.5} value={s.sound.voice_gain_db} format={db} set={snd("voice_gain_db")} disabled={!p.hasVoice} />
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
          <Switch label="Lower the exhaust when you talk" on={s.sound.ducking} set={snd("ducking")} />
          {s.sound.ducking && (
            <Slider label="Lower by" unit=" dB" min={1} max={12} step={0.5} value={s.sound.ducking_db} set={snd("ducking_db")} disabled={!p.hasVoice} />
          )}
        </div>
      </Group>
      <Group title="Loudness">
        <Segmented
          label="Loudness target"
          value={String(s.sound.loudness_lufs)}
          options={[
            ["-14", "−14 LUFS social"],
            ["-16", "−16 YouTube"],
            ["-11", "−11 Loud"],
          ]}
          onChange={(v) => snd("loudness_lufs")(Number(v))}
        />
        <Slider label="Peak ceiling" min={-3} max={0} step={0.1} value={s.sound.true_peak_db} format={(v) => `${v.toFixed(1)} dBTP`} set={snd("true_peak_db")} />
      </Group>
    </>
  );
}

function PrivacyTab(p: Props) {
  const pv = p.settings.privacy;
  const set = <K extends keyof PrivacySettings>(k: K) => (v: PrivacySettings[K]) =>
    p.setSettings((x) => ({ ...x, privacy: { ...x.privacy, [k]: v } }));
  const spot = pv.dashboard_spot;
  return (
    <>
      <Group
        title="Speed limit"
        aside={reset(() => p.setSettings((x) => ({ ...x, privacy: { ...DEFAULT_PRIVACY, dashboard_spot: x.privacy.dashboard_spot } })))}
      >
        <Slider label="Too fast above" unit=" km/h" min={30} max={200} step={5} value={pv.speed_limit_kmh} set={set("speed_limit_kmh")} />
        <p className="text-[12px] text-muted">Measured by the camera&apos;s GPS. Moments above it are marked in red on the timeline.</p>
      </Group>
      <Group title="Speed readout">
        <Switch label="Hide the HUD speed when too fast" on={pv.hide_hud_speed} set={set("hide_hud_speed")} />
        {pv.hide_hud_speed && (
          <Segmented
            label="Hide style"
            value={p.hud.redactStyle}
            options={[
              ["REDACTED", "Redacted bar"],
              ["BLUR", "Pixelated"],
            ]}
            onChange={(v) => p.setHud((h) => ({ ...h, redactStyle: v }))}
          />
        )}
      </Group>
      <Group title="Bike dashboard">
        <Segmented<BlurWhen>
          label="Blur the dashboard"
          value={pv.dashboard}
          options={[
            ["OFF", "Off"],
            ["ABOVE_LIMIT", "When too fast"],
            ["ALWAYS", "Always"],
          ]}
          onChange={set("dashboard")}
        />
        {pv.dashboard !== "OFF" && (
          <>
            <Button variant={p.marking ? "primary" : "secondary"} className="w-full" onClick={() => p.setMarking(!p.marking)}>
              {p.marking ? "Done" : spot ? "Move the blur" : "Mark the dashboard"}
            </Button>
            <p className="text-[12px] text-muted">
              {p.marking
                ? "Click the dashboard in the video. Switch the camera to Rider if it faces you."
                : spot
                  ? `Placed on the ${spot.lens === "REAR" ? "rider" : "road"} lens. It follows the dashboard whatever the view, as long as the camera is fixed to the bike.`
                  : "Not placed yet, so nothing is blurred."}
            </p>
            {spot && (
              <Slider
                label="Blur size"
                min={0.03}
                max={0.2}
                step={0.005}
                value={spot.radius}
                format={(v) => `${Math.round(v * 200)} %`}
                set={(radius) => set("dashboard_spot")({ ...spot, radius })}
              />
            )}
          </>
        )}
      </Group>
      <Group title="Other vehicles">
        <Switch
          label="Blur license plates"
          hint="Finds plates in every rendered clip and pixelates them. Adds a detection pass before each render; the detector (29 MB) downloads on first use."
          on={pv.plates}
          set={set("plates")}
        />
      </Group>
    </>
  );
}
