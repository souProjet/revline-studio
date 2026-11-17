//! On Linux, WebKitGTK cannot decode `<video>` from Tauri's `asset://` scheme (GStreamer
//! never receives ranged reads). A loopback HTTP server with `Range` support is the workaround.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use anyhow::{bail, Context};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};

const READ_BUF: usize = 64 * 1024;

pub struct MediaProxy {
    port: u16,
    token: String,
    next_id: AtomicU64,
    /// Canonical path -> id
    paths: Mutex<HashMap<PathBuf, String>>,
    ids: Mutex<HashMap<String, PathBuf>>,
}

impl MediaProxy {
    pub async fn start() -> anyhow::Result<Arc<Self>> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .context("bind loopback media proxy")?;
        let port = listener.local_addr()?.port();
        let token = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos());
        let proxy = Arc::new(Self {
            port,
            token,
            next_id: AtomicU64::new(1),
            paths: Mutex::new(HashMap::new()),
            ids: Mutex::new(HashMap::new()),
        });
        let serve = proxy.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { continue };
                let p = serve.clone();
                tokio::spawn(async move {
                    let _ = p.handle_conn(stream).await;
                });
            }
        });
        Ok(proxy)
    }

    pub async fn url_for(&self, path: &Path) -> anyhow::Result<String> {
        let canon = path
            .canonicalize()
            .with_context(|| format!("media file not found: {}", path.display()))?;
        if !path_allowed(&canon) {
            bail!("path outside allowed media roots: {}", canon.display());
        }
        let mut paths = self.paths.lock().await;
        let id = if let Some(id) = paths.get(&canon) {
            id.clone()
        } else {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
            paths.insert(canon.clone(), id.clone());
            self.ids.lock().await.insert(id.clone(), canon);
            id
        };
        Ok(format!("http://127.0.0.1:{port}/media/{id}?t={token}", port = self.port, id = id, token = self.token))
    }

    async fn handle_conn(&self, mut stream: TcpStream) -> io::Result<()> {
        let mut buf = vec![0u8; 4096];
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        let req = String::from_utf8_lossy(&buf[..n]);
        let mut lines = req.lines();
        let Some(request_line) = lines.next() else { return Ok(()) };
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        if method != "GET" && method != "HEAD" && method != "OPTIONS" {
            return write_response(&mut stream, 405, "text/plain", b"Method Not Allowed", None).await;
        }
        let mut range: Option<(u64, u64)> = None;
        let mut origin: Option<String> = None;
        for line in lines {
            if let Some(v) = line.strip_prefix("Range: ") {
                range = parse_range(v);
            } else if let Some(v) = line.strip_prefix("Origin: ") {
                origin = Some(v.trim().to_owned());
            } else if line.is_empty() {
                break;
            }
        }
        let acao = cors_origin(origin.as_deref());
        if method == "OPTIONS" {
            let headers = format!(
                "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {acao}\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                acao = acao
            );
            stream.write_all(headers.as_bytes()).await?;
            return Ok(());
        }
        let (id, token) = match parse_target(target) {
            Some(t) => t,
            None => return write_response(&mut stream, 404, "text/plain", b"Not Found", Some(&acao)).await,
        };
        if token != self.token {
            return write_response(&mut stream, 403, "text/plain", b"Forbidden", Some(&acao)).await;
        }
        let path = self.ids.lock().await.get(&id).cloned();
        let Some(path) = path else {
            return write_response(&mut stream, 404, "text/plain", b"Not Found", Some(&acao)).await;
        };
        self.serve_file(&mut stream, &path, range, method == "HEAD", &acao).await
    }

    async fn serve_file(
        &self,
        stream: &mut TcpStream,
        path: &Path,
        range: Option<(u64, u64)>,
        head_only: bool,
        acao: &str,
    ) -> io::Result<()> {
        let mut file = tokio::fs::File::open(path).await?;
        let total = file.metadata().await?.len();
        let (start, end) = range.unwrap_or((0, total.saturating_sub(1)));
        let end = end.min(total.saturating_sub(1));
        if start > end || start >= total {
            let body = b"Range Not Satisfiable";
            let headers = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Type: text/plain\r\nContent-Range: bytes */{total}\r\nAccess-Control-Allow-Origin: {acao}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len(),
                total = total,
                acao = acao
            );
            stream.write_all(headers.as_bytes()).await?;
            if !head_only {
                stream.write_all(body).await?;
            }
            return Ok(());
        }
        let len = end - start + 1;
        file.seek(io::SeekFrom::Start(start)).await?;
        let partial = range.is_some();
        let status = if partial { "206 Partial Content" } else { "200 OK" };
        let ctype = mime_for(path);
        let range_hdr = if partial {
            format!("Content-Range: bytes {start}-{end}/{total}\r\n", start = start, end = end, total = total)
        } else {
            String::new()
        };
        let headers = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: {acao}\r\nContent-Length: {len}\r\n{range_hdr}Connection: close\r\n\r\n",
            status = status,
            ctype = ctype,
            acao = acao,
            len = len,
            range_hdr = range_hdr
        );
        stream.write_all(headers.as_bytes()).await?;
        if head_only {
            return Ok(());
        }
        let mut left = len;
        let mut chunk = vec![0u8; READ_BUF];
        while left > 0 {
            let to_read = chunk.len().min(left as usize);
            let n = file.read(&mut chunk[..to_read]).await?;
            if n == 0 {
                break;
            }
            stream.write_all(&chunk[..n]).await?;
            left -= n as u64;
        }
        Ok(())
    }
}

fn cors_origin(origin: Option<&str>) -> String {
    match origin {
        Some(o) if o.starts_with("http://localhost:") || o.starts_with("http://127.0.0.1:") || o.starts_with("tauri://") => o.to_owned(),
        _ => "*".to_owned(),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("lrv" | "mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn parse_target(target: &str) -> Option<(String, String)> {
    let path = target.split('?').next()?;
    let mut segs = path.trim_start_matches('/').split('/');
    if segs.next()? != "media" {
        return None;
    }
    let id = segs.next()?.to_owned();
    let q = target.split('?').nth(1).unwrap_or("");
    let token = q
        .split('&')
        .find_map(|p| p.strip_prefix("t="))
        .unwrap_or("")
        .to_owned();
    Some((id, token))
}

fn parse_range(header: &str) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: u64 = a.parse().ok()?;
    let end: u64 = if b.is_empty() { u64::MAX } else { b.parse().ok()? };
    Some((start, end))
}

async fn write_response(
    stream: &mut TcpStream,
    code: u16,
    ctype: &str,
    body: &[u8],
    acao: Option<&str>,
) -> io::Result<()> {
    let status = match code {
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let cors = acao.map(|o| format!("Access-Control-Allow-Origin: {o}\r\n")).unwrap_or_default();
    let headers = format!(
        "HTTP/1.1 {code} {status}\r\nContent-Type: {ctype}\r\n{cors}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await
}

/// Same roots as `tauri.conf.json` asset protocol scope.
fn path_allowed(path: &Path) -> bool {
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let prefixes: Vec<PathBuf> = [
        Some(PathBuf::from("/media")),
        Some(PathBuf::from("/run/media")),
        Some(PathBuf::from("/mnt")),
        Some(PathBuf::from("/Volumes")),
        home.clone(),
    ]
    .into_iter()
    .flatten()
    .collect();
    prefixes.iter().any(|root| path.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_media_target() {
        let (id, t) = parse_target("/media/42?t=abc").unwrap();
        assert_eq!(id, "42");
        assert_eq!(t, "abc");
    }

    #[test]
    fn parse_bytes_range() {
        assert_eq!(parse_range("bytes=0-1023"), Some((0, 1023)));
    }
}