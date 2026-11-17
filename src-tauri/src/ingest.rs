//! Finds Insta360 recordings on mounted SD cards or in a chosen folder and pairs each
//! `.insv` with its `.lrv` proxy. Nothing is copied: the app works on the files in place.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct MediaItem {
    pub insv_path: PathBuf,
    pub lrv_path: Option<PathBuf>,
    pub size_bytes: u64,
    /// `YYYYMMDD_HHMMSS` from the Insta360 file name.
    pub recorded_at: String,
}

/// Insta360 names `VID_20250614_183012_00_042.insv` and `LRV_20250614_183012_01_042.lrv`:
/// the lens/stream field differs, date, time and clip number match.
fn pairing_key(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts: Vec<&str> = stem.split('_').collect();
    match parts.as_slice() {
        [_, date, time, _, idx, ..] => Some(format!("{date}_{time}_{idx}")),
        _ => None,
    }
}

fn has_ext(p: &Path, ext: &str) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Mount points to search when no folder is given: removable media on Linux, every mounted
/// volume except the system disk on macOS.
fn default_roots() -> Vec<PathBuf> {
    let user = std::env::var("USER").unwrap_or_default();
    let mut roots: Vec<PathBuf> = [format!("/media/{user}"), format!("/run/media/{user}"), "/media".to_owned()]
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect();
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        // The boot volume appears here as a symlink to `/`; walking it would scan the whole disk.
        roots.extend(entries.flatten().map(|e| e.path()).filter(|p| !p.is_symlink() && p.is_dir()));
    }
    roots
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() && depth > 0 {
            walk(&p, depth - 1, out);
        } else if has_ext(&p, "insv") || has_ext(&p, "lrv") {
            out.push(p);
        }
    }
}

pub fn scan(root: Option<PathBuf>) -> Vec<MediaItem> {
    let roots = root.map_or_else(default_roots, |r| vec![r]);
    let mut files = Vec::new();
    for r in &roots {
        // card root -> DCIM -> Camera01 -> files
        walk(r, 4, &mut files);
    }
    let lrvs: Vec<&PathBuf> = files.iter().filter(|p| has_ext(p, "lrv")).collect();
    let mut items: Vec<MediaItem> = files
        .iter()
        .filter(|p| has_ext(p, "insv"))
        .map(|insv| {
            let key = pairing_key(insv);
            MediaItem {
                insv_path: insv.clone(),
                lrv_path: lrvs.iter().find(|l| key.is_some() && pairing_key(l) == key).map(|l| (*l).clone()),
                size_bytes: std::fs::metadata(insv).map_or(0, |m| m.len()),
                recorded_at: key.map(|k| k.chars().take(15).collect()).unwrap_or_default(),
            }
        })
        .collect();
    items.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_insv_with_lrv() {
        let a = pairing_key(Path::new("/x/VID_20250614_183012_00_042.insv"));
        let b = pairing_key(Path::new("/x/LRV_20250614_183012_01_042.lrv"));
        assert_eq!(a, b);
        assert_eq!(a.as_deref(), Some("20250614_183012_042"));
    }
}
