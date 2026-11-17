# Revline Studio

Desktop app that turns a raw Insta360 X4 ride into short 9:16 "Pure Sound" edits for TikTok, Reels and Shorts. It was built around a Yamaha MT-09 (CP3 triple) with an open exhaust, but the pipeline works with any bike whose engine note is audible on the camera's microphones.

You point it at the camera's SD card. It listens to the exhaust to find the moments worth posting (hard pulls, quickshifts, pops on decel, deep corners), reads the camera's gyro and GPS to level the horizon and draw a telemetry HUD, then renders each highlight with hardware encoding.

## What it does

**Highlight detection from sound.** The exhaust track is decoded once and analyzed in Rust:

- Engine RPM is tracked from the firing frequency (RPM/40 Hz for a crossplane triple) with subharmonic summation on a 1/48-octave grid and a Viterbi path that penalizes implausible jumps.
- Quickshifts are found as a gear-ratio RPM drop that coincides with the short ignition-cut dip in the envelope.
- Pops and bangs are crest-factor transients in the crackle band (above 1.5 kHz) while the engine is decelerating.
- An Action Score per second combines RPM, how fast it climbs, loudness, pops and shifts. Smart Clips of 12 to 25 seconds are ranked on it plus lean angle, and their cuts snap to quiet moments so a pull is never chopped.
- An optional phone recording (for example a lav mic in the helmet) is synced by onset cross-correlation, including clock drift.

**Telemetry from the camera.** IMU and GPS are read from the `.insv` with [telemetry-parser](https://github.com/AdrianEddy/telemetry-parser). Lean angle comes from a gyro-propagated gravity vector with centripetal compensation from GPS speed; the camera mount is calibrated automatically. Horizon Lock counter-rotates the view so the road stays level while the bike leans.

**Editing.** A live preview reprojects the low-res `.lrv` proxy in WebGL with the same math as the final render, with a 60 fps HUD on top. The HUD is fully configurable: drag each element where you want it (with TikTok safe zones shown), resize, recolor, switch units, set lean warning thresholds, and redact speed above a limit. Each clip can be trimmed on the timeline, which also shows the RPM curve, exhaust and voice waveforms, and the automatic front/rear camera switches.

**Sound.** Exhaust EQ (high-pass, body, rasp), exhaust and voice levels, voice denoise (built-in or an RNNoise model), sidechain ducking of the exhaust under speech, and two-pass loudness normalization to a chosen target and true-peak ceiling.

**Rendering.** ffmpeg does the 360 reprojection (`v360`), per-frame horizon rotation, LUT, vignette, HUD overlay and audio mastering in one pass, encoding on the GPU. Renders run in a queue with live progress (frames, fps, speed, time left, file size) and GPU load. Output is written to a `.part` file and only renamed once complete, so a crash or cancel never leaves a broken video behind.

## Requirements

| | Linux | macOS |
|---|---|---|
| Encoder | NVIDIA GPU with NVENC (H.264, HEVC; AV1 on RTX 40 and newer) | VideoToolbox (H.264, HEVC) |
| Decode | CUDA (`-hwaccel cuda`) | VideoToolbox |
| ffmpeg | Built with `--enable-nvenc --enable-cuda`, on `PATH` with `ffprobe` | Any recent build with VideoToolbox, on `PATH` |
| Webview | WebKitGTK 4.1 plus GStreamer `gst-libav` to play the `.lrv` proxy | Built in |

Build tools: Node.js 22 or newer and Rust 1.90 or newer, plus the [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/).

**NVIDIA RTX 50 series.** Blackwell cards need a 570-series driver or newer, and the ffmpeg build must have been compiled against an NVENC SDK version the installed driver supports. When it does not, ffmpeg fails with "Driver does not support the required nvenc API version". The app runs a short test encode for each codec at startup; the Hardware panel under Export shows which codecs work and why the others failed, and unavailable codecs cannot be selected.

Windows is not supported yet. The code compiles toward NVENC there but has never been run.

## Getting started

```bash
npm install
npm run tauri dev
```

Insert the camera's SD card (or pick a folder), select a recording and press **Find highlights**. The header shows each analysis stage and its progress as it runs.

A release build (`.deb` and AppImage on Linux):

```bash
npm run tauri build
```

## Tests

```bash
cd src-tauri
cargo test --lib
```

One test is ignored by default because it renders a synthetic dual-fisheye clip through ffmpeg with the platform's hardware encoder. Run it on a machine with NVENC or VideoToolbox:

```bash
cd src-tauri
cargo test --lib -- --include-ignored
```

## Project layout

```
src/                      Next.js 15 frontend (static export, React 19, Tailwind 4)
  app/page.tsx            studio layout and state
  components/             viewport, HUD canvas, timeline, inspector, render queue
  lib/hud.ts              HUD renderer shared by the preview and the export
  lib/ipc.ts              Tauri commands, events, HUD frame streaming
  lib/types.ts            mirror of src-tauri/src/types.rs
src-tauri/src/            Rust backend
  ingest.rs               SD card and folder scan, .insv and .lrv pairing
  audio_analyzer.rs       decode, RPM tracking, shifts, pops, Action Score, voice, sync, Smart Clips
  telemetry.rs            IMU and GPS fusion, lean, Horizon Lock
  render_pipeline.rs      ffmpeg graph, audio mastering, encoder settings, progress
  system.rs               ffmpeg and GPU detection, encoder test, GPU monitor
  lib.rs                  commands, state, progress events
```

HUD frames are drawn in the webview and streamed to ffmpeg as PNG over Tauri's raw-body IPC, so the export matches the preview exactly.

## Known limitations

- Tested on synthetic signals and on macOS. It has not yet been validated on long real rides or on Linux with an RTX 50 card.
- Camera pitch changes are applied only when they exceed 1 degree, to keep the render fast; roll is applied every frame.
- RPM tracking assumes one firing frequency per engine. The divisor is set for a crossplane triple.
- Clips are limited to 1 to 180 seconds.

## License

[MIT](LICENSE)
