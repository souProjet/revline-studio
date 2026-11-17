//! License-plate detection for the blur pass.
//!
//! Model: open-image-models `yolo-v9-s-608-license-plates-end2end` (ONNX, non-maximum
//! suppression inside the graph), downloaded on first use and checked against its SHA-256.
//! Input `images` f32 [1,3,608,608] RGB 0..1, letterboxed with gray 114; output `output0`
//! [N,7] = batch, x1, y1, x2, y2, class, score in letterboxed pixels. Runs through ONNX
//! Runtime on CUDA (Linux) or CoreML (macOS) when available, else on the CPU.

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use anyhow::{anyhow, bail, Context, Result};
use ort::{
    environment::Environment,
    session::Session,
    value::Tensor,
};
use sha2::{Digest, Sha256};

pub const MODEL_FILE: &str = "yolo-v9-s-608-license-plates-end2end.onnx";
const MODEL_URL: &str = "https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-s-608-license-plates-end2end.onnx";
const MODEL_SHA256: &str = "2b878b38d9aa07b6ddc3ea75c4ffcb39869bc5c218e0a14002f60ab2f7b0be9a";
const MODEL_BYTES: u64 = 28_612_350;
const SIDE: usize = 608;
/// The project's own default; blurring a false positive is cheaper than missing a plate.
const MIN_SCORE: f32 = 0.25;

/// A detected plate in frame pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlateBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub score: f32,
}

impl PlateBox {
    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }
    pub fn iou(&self, o: &PlateBox) -> f32 {
        let w = (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0);
        let h = (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0);
        let inter = w * h;
        let union = self.width() * self.height() + o.width() * o.height() - inter;
        if union > 0.0 { inter / union } else { 0.0 }
    }
    /// Smallest box covering both.
    pub fn hull(&self, o: &PlateBox) -> PlateBox {
        PlateBox { x0: self.x0.min(o.x0), y0: self.y0.min(o.y0), x1: self.x1.max(o.x1), y1: self.y1.max(o.y1), score: self.score.max(o.score) }
    }
}

/// Path of the model in `dir`, downloading it first if needed. Blocking.
pub fn ensure_model(dir: &Path, on_progress: &dyn Fn(f64)) -> Result<PathBuf> {
    let path = dir.join(MODEL_FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() == MODEL_BYTES) {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)?;
    let part = dir.join(format!("{MODEL_FILE}.part"));
    let result = (|| -> Result<()> {
        let resp = ureq::get(MODEL_URL).call().context("could not reach GitHub to download the plate model")?;
        let mut body = resp.into_body().into_reader();
        let mut file = File::create(&part)?;
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut got = 0u64;
        loop {
            let n = body.read(&mut buf)?;
            if n == 0 {
                break;
            }
            got += n as u64;
            if got > MODEL_BYTES {
                bail!("the plate model download is larger than expected");
            }
            hash.update(&buf[..n]);
            file.write_all(&buf[..n])?;
            on_progress(got as f64 / MODEL_BYTES as f64);
        }
        file.sync_all()?;
        let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != MODEL_BYTES || digest != MODEL_SHA256 {
            bail!("the downloaded plate model is corrupt (size {got}, sha256 {digest})");
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, &path)?;
    Ok(path)
}

fn environment() -> Result<Environment> {
    static ENV: OnceLock<Environment> = OnceLock::new();
    if let Some(e) = ENV.get() {
        return Ok(e.clone());
    }
    let e = ort::init().with_name("revline").build().map_err(|e| anyhow!("ONNX Runtime: {e}"))?;
    Ok(ENV.get_or_init(|| e).clone())
}

pub struct Detector {
    session: Session,
    input: Vec<f32>,
}

impl Detector {
    pub fn load(model: &Path) -> Result<Self> {
        let env = environment()?;
        let session = Session::builder(&env)
            .map_err(|e| anyhow!("ONNX Runtime: {e}"))?
            .with_execution_providers([
                #[cfg(target_os = "linux")]
                ort::ep::CUDA::default().build(),
                // The NMS tail has dynamic shapes that CoreML rejects when a frame has no
                // plate, so it stays on the CPU.
                #[cfg(target_os = "macos")]
                ort::ep::CoreML::default()
                    .with_static_input_shapes(true)
                    .with_model_format(ort::ep::coreml::ModelFormat::MLProgram)
                    .build(),
            ])
            .map_err(|e| anyhow!("ONNX Runtime: {e}"))?
            .commit_from_file(model)
            .map_err(|e| anyhow!("could not load the plate model: {e}"))?;
        Ok(Self { session, input: vec![0.0; 3 * SIDE * SIDE] })
    }

    /// Plates in a packed RGB24 frame, in its pixel coordinates.
    pub fn detect(&mut self, rgb: &[u8], w: usize, h: usize) -> Result<Vec<PlateBox>> {
        if rgb.len() != w * h * 3 || w == 0 || h == 0 {
            bail!("frame is {} bytes, expected {w}x{h} RGB", rgb.len());
        }
        let r = (SIDE as f32 / w as f32).min(SIDE as f32 / h as f32);
        let (nw, nh) = ((w as f32 * r).round() as usize, (h as f32 * r).round() as usize);
        let (dw, dh) = ((SIDE - nw) / 2, (SIDE - nh) / 2);
        letterbox(rgb, w, h, nw, nh, dw, dh, &mut self.input);

        let tensor = Tensor::from_array(([1usize, 3, SIDE, SIDE], self.input.clone())).map_err(|e| anyhow!("{e}"))?;
        let outputs = match self.session.run(ort::inputs!["images" => tensor]) {
            Ok(o) => o,
            // CoreML can't run the NMS tail on an empty candidate list: no plate in this frame.
            Err(e) if e.to_string().contains("has zero elements") => return Ok(Vec::new()),
            Err(e) => bail!("plate detection failed: {e}"),
        };
        let (shape, data) = outputs["output0"].try_extract_tensor::<f32>().map_err(|e| anyhow!("{e}"))?;
        let cols = shape.last().copied().unwrap_or(0) as usize;
        if cols < 7 {
            return Ok(Vec::new());
        }
        let (fw, fh) = (w as f32, h as f32);
        Ok(data
            .chunks_exact(cols)
            .filter(|d| d[6] >= MIN_SCORE)
            .map(|d| PlateBox {
                x0: ((d[1] - dw as f32) / r).clamp(0.0, fw),
                y0: ((d[2] - dh as f32) / r).clamp(0.0, fh),
                x1: ((d[3] - dw as f32) / r).clamp(0.0, fw),
                y1: ((d[4] - dh as f32) / r).clamp(0.0, fh),
                score: d[6],
            })
            .filter(|b| plausible(b, fw, fh))
            .collect())
    }
}

/// Plates are wider than tall (EU 4.7:1, square moto plates about 1.3:1) and never fill the
/// frame; the model can report a frame-sized box on texture-less input.
fn plausible(b: &PlateBox, fw: f32, fh: f32) -> bool {
    let (w, h) = (b.width(), b.height());
    w >= 4.0 && h >= 2.0 && (0.7..=9.0).contains(&(w / h)) && w * h <= 0.08 * fw * fh
}

/// Bilinear resize into the centered `nw` x `nh` window of a gray (114) 608² CHW tensor.
#[allow(clippy::too_many_arguments)]
fn letterbox(rgb: &[u8], w: usize, h: usize, nw: usize, nh: usize, dw: usize, dh: usize, out: &mut [f32]) {
    out.fill(114.0 / 255.0);
    let plane = SIDE * SIDE;
    let sx = w as f32 / nw as f32;
    let sy = h as f32 / nh as f32;
    for y in 0..nh {
        let fy = ((y as f32 + 0.5) * sy - 0.5).clamp(0.0, (h - 1) as f32);
        let (y0, ty) = (fy as usize, fy.fract());
        let y1 = (y0 + 1).min(h - 1);
        for x in 0..nw {
            let fx = ((x as f32 + 0.5) * sx - 0.5).clamp(0.0, (w - 1) as f32);
            let (x0, tx) = (fx as usize, fx.fract());
            let x1 = (x0 + 1).min(w - 1);
            let o = (y + dh) * SIDE + x + dw;
            for c in 0..3 {
                let p = |xx: usize, yy: usize| f32::from(rgb[(yy * w + xx) * 3 + c]);
                let top = p(x0, y0) * (1.0 - tx) + p(x1, y0) * tx;
                let bot = p(x0, y1) * (1.0 - tx) + p(x1, y1) * tx;
                out[c * plane + o] = (top * (1.0 - ty) + bot * ty) / 255.0;
            }
        }
    }
}

/// Number of `drawbox@p0..` filters the blur mask has, so the most plates blurred at once.
pub const SLOTS: usize = 12;

/// `sendcmd` script that moves the mask's drawbox filters over every plate, frame by frame.
///
/// Detections come at a lower rate than the video. Each frame takes the boxes of the
/// detections just before and after it, the one before that (to ride over a single missed
/// detection), and the hull of each box matched across the gap (the plate moved in between),
/// grown by a margin, scaled by `scale` to output pixels and merged when they overlap.
/// `None` when no plate was ever found.
pub fn mask_script(dets: &[(f64, Vec<PlateBox>)], frames: usize, fps: f64, scale: f32, w: u32, h: u32) -> Option<String> {
    if dets.iter().all(|(_, b)| b.is_empty()) {
        return None;
    }
    let (fw, fh) = (w as f32, h as f32);
    let mut slots: Vec<Option<[i32; 4]>> = vec![None; SLOTS];
    let mut script = String::new();
    for i in 0..frames {
        let t = i as f64 / fps;
        let k = dets.partition_point(|d| d.0 <= t).saturating_sub(1);
        let at = |j: usize| dets.get(j).map_or(&[][..], |d| d.1.as_slice());
        let mut boxes: Vec<PlateBox> = Vec::new();
        boxes.extend_from_slice(at(k));
        boxes.extend_from_slice(at(k + 1));
        if k > 0 {
            boxes.extend_from_slice(at(k - 1));
        }
        for a in at(k) {
            for b in at(k + 1) {
                let near = ((a.x0 + a.x1) - (b.x0 + b.x1)).abs() / 2.0 < 1.5 * a.width().max(b.width());
                if a.iou(b) > 0.0 || near {
                    boxes.push(a.hull(b));
                }
            }
        }
        let mut grown: Vec<PlateBox> = boxes
            .iter()
            .map(|b| {
                let (mx, my) = (0.15 * b.width() + 3.0, 0.3 * b.height() + 3.0);
                PlateBox {
                    x0: ((b.x0 - mx) * scale).clamp(0.0, fw),
                    y0: ((b.y0 - my) * scale).clamp(0.0, fh),
                    x1: ((b.x1 + mx) * scale).clamp(0.0, fw),
                    y1: ((b.y1 + my) * scale).clamp(0.0, fh),
                    score: b.score,
                }
            })
            .collect();
        merge_overlapping(&mut grown);
        grown.sort_by(|a, b| (b.width() * b.height()).total_cmp(&(a.width() * a.height())));
        let mut cmds = Vec::new();
        for (n, slot) in slots.iter_mut().enumerate() {
            let want = grown.get(n).map(|b| {
                let even = |v: f32| (v / 2.0).round() as i32 * 2;
                let (x, y) = (even(b.x0), even(b.y0));
                [x, y, (even(b.x1) - x).max(2), (even(b.y1) - y).max(2)]
            });
            if want != *slot {
                let [x, y, bw, bh] = want.unwrap_or([-64, -64, 8, 8]);
                cmds.push(format!("drawbox@p{n} x {x}, drawbox@p{n} y {y}, drawbox@p{n} w {bw}, drawbox@p{n} h {bh}"));
                *slot = want;
            }
        }
        if !cmds.is_empty() {
            use std::fmt::Write as _;
            let _ = writeln!(script, "{t:.4} {};", cmds.join(", "));
        }
    }
    Some(script)
}

fn merge_overlapping(boxes: &mut Vec<PlateBox>) {
    let mut i = 0;
    while i < boxes.len() {
        let mut merged = false;
        let mut j = i + 1;
        while j < boxes.len() {
            let (a, b) = (boxes[i], boxes[j]);
            if a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1 {
                boxes[i] = a.hull(&b);
                boxes.swap_remove(j);
                merged = true;
            } else {
                j += 1;
            }
        }
        if !merged {
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plausibility_rejects_frame_sized_and_tall_boxes() {
        let b = |x0, y0, x1, y1| PlateBox { x0, y0, x1, y1, score: 0.9 };
        assert!(plausible(&b(100.0, 100.0, 220.0, 130.0), 1080.0, 1920.0));
        assert!(!plausible(&b(0.0, 0.0, 1080.0, 1920.0), 1080.0, 1920.0));
        assert!(!plausible(&b(100.0, 100.0, 120.0, 200.0), 1080.0, 1920.0));
    }

    #[test]
    fn mask_follows_a_moving_plate_and_hides_when_gone() {
        let b = |x: f32| PlateBox { x0: x, y0: 100.0, x1: x + 60.0, y1: 115.0, score: 0.9 };
        // 10 Hz detections in a 640x360 frame, rendered at 1280x720, 30 fps, for 1 s.
        let dets: Vec<(f64, Vec<PlateBox>)> =
            (0..10).map(|k| (k as f64 / 10.0, if k < 5 { vec![b(100.0 + 20.0 * k as f32)] } else { vec![] })).collect();
        let script = mask_script(&dets, 30, 30.0, 2.0, 1280, 720).unwrap();
        let first = script.lines().next().unwrap();
        assert!(first.starts_with("0.0000 drawbox@p0 x "), "{first}");
        // The plate was last seen at 0.4 s: it is held for one more detection, then hidden.
        let last = script.lines().last().unwrap();
        assert!(last.contains("drawbox@p0 x -64"), "{last}");
        let t_hide: f64 = last.split(' ').next().unwrap().parse().unwrap();
        assert!((0.55..=0.75).contains(&t_hide), "{t_hide}");
        assert!(mask_script(&[(0.0, vec![])], 30, 30.0, 1.0, 640, 360).is_none());
    }

    /// Needs the model (REVLINE_PLATE_MODEL) and an image with a plate (REVLINE_PLATE_IMAGE),
    /// decoded through ffmpeg. `cargo test -- --ignored detects_a_plate`.
    #[test]
    #[ignore]
    fn detects_a_plate() {
        let model = std::env::var("REVLINE_PLATE_MODEL").unwrap();
        let image = std::env::var("REVLINE_PLATE_IMAGE").unwrap();
        let probe = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
            .arg(&image)
            .output()
            .unwrap();
        let dims = String::from_utf8_lossy(&probe.stdout);
        let mut it = dims.trim().split(',').map(|v| v.parse::<usize>().unwrap());
        let (w, h) = (it.next().unwrap(), it.next().unwrap());
        let raw = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-i", &image, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap()
            .stdout;
        let mut d = Detector::load(Path::new(&model)).unwrap();
        let boxes = d.detect(&raw, w, h).unwrap();
        eprintln!("{boxes:?}");
        assert!(!boxes.is_empty());
    }
}
