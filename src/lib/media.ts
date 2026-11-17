import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** URL the WebView can decode: HTTP loopback on Linux, asset protocol elsewhere. */
export async function previewMediaUrl(path: string): Promise<string> {
  if (typeof window === "undefined") return convertFileSrc(path);
  try {
    return await invoke<string>("preview_media_url", { path });
  } catch {
    return convertFileSrc(path);
  }
}