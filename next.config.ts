import type { NextConfig } from "next";

// Tauri serves the static export from ../out; there is no Node server at runtime.
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default config;
