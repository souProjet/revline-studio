"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Mat3 } from "@/lib/viewMatrix";

export interface ProxyViewportHandle {
  video: HTMLVideoElement | null;
}

interface Props {
  src: string | null;
  /** Called every animation frame with the current source time; returns the view matrix. */
  viewAt: (tMs: number) => Mat3;
  lensFovDeg: number;
  hFovDeg: number;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Same mapping as ffmpeg v360 output=flat <- input=dfisheye: output ray -> M -> lens ray ->
// equidistant fisheye, front lens on the left half, back lens mirrored on the right half.
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
uniform sampler2D uTex;
uniform mat3 uM;
uniform vec2 uTan;
uniform float uHalfFov;
void main() {
  vec3 ray = normalize(vec3((vUv.x * 2.0 - 1.0) * uTan.x, (vUv.y * 2.0 - 1.0) * uTan.y, 1.0));
  vec3 r = uM * ray;
  bool front = r.z >= 0.0;
  vec3 l = front ? r : vec3(-r.x, r.y, -r.z);
  float theta = acos(clamp(l.z, -1.0, 1.0));
  float rr = theta / uHalfFov;
  if (rr > 1.0) { color = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 p = normalize(l.xy + 1e-9) * rr;
  vec2 uv = vec2((p.x * 0.5 + 0.5) * 0.5 + (front ? 0.0 : 0.5), p.y * 0.5 + 0.5);
  color = texture(uTex, uv);
}`;

/** Plays the `.lrv` proxy (dual fisheye, side by side) reprojected to the 9:16 render view. */
const ProxyViewport = forwardRef<ProxyViewportHandle, Props>(function ProxyViewport(
  { src, viewAt, lensFovDeg, hFovDeg },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const live = useRef({ viewAt, lensFovDeg, hFovDeg });
  live.current = { viewAt, lensFovDeg, hFovDeg };
  useImperativeHandle(ref, () => ({ get video() { return videoRef.current; } }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const gl = canvas?.getContext("webgl2");
    if (!gl || !video) return;

    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const uM = gl.getUniformLocation(prog, "uM");
    const uTan = gl.getUniformLocation(prog, "uTan");
    const uHalfFov = gl.getUniformLocation(prog, "uHalfFov");

    let raf = 0;
    const tick = () => {
      const { viewAt, lensFovDeg, hFovDeg } = live.current;
      if (video.readyState >= 2) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }
      const m = viewAt(video.currentTime * 1000);
      // GLSL mat3 is column-major: transpose the row-major matrix.
      gl.uniformMatrix3fv(uM, true, m);
      const th = Math.tan((hFovDeg * Math.PI) / 360);
      gl.uniform2f(uTan, th, (th * 1920) / 1080);
      gl.uniform1f(uHalfFov, (lensFovDeg * Math.PI) / 360);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, []);

  return (
    <>
      <video ref={videoRef} src={src ?? undefined} className="hidden" muted playsInline crossOrigin="anonymous" />
      <canvas ref={canvasRef} width={540} height={960} className="absolute inset-0 h-full w-full" />
    </>
  );
});

export default ProxyViewport;
