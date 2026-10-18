"use client";
// Browser-side helpers for in-app capture: camera, orientation sensors, live quality checks, uploads.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceAngles, OrientationSample } from "@/lib/orientation";

export type CameraError = "insecure" | "denied" | "notfound" | "unknown" | null;

export function useCamera(active: boolean, withAudio = false) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<CameraError>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let s: MediaStream | null = null;
    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext ? "notfound" : "insecure");
        return;
      }
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: withAudio,
        });
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        setStream(s);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (e) {
        const name = (e as Error).name;
        setError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "notfound" : "unknown");
      }
    })();
    return () => {
      cancelled = true;
      s?.getTracks().forEach((t) => t.stop());
      setReady(false);
      setStream(null);
    };
  }, [active, withAudio]);

  return { videoRef, stream, ready, error };
}

export const CAMERA_ERROR_TEXT: Record<Exclude<CameraError, null>, string> = {
  insecure: "The camera needs a secure (https) connection. Open the capture link on your phone, or use the HTTPS dev server.",
  denied: "Camera permission was denied. Allow camera access for this site in your browser settings, then try again.",
  notfound: "No camera was found on this device.",
  unknown: "The camera couldn't be started. Close other apps using the camera and try again.",
};

/**
 * Device orientation with the iOS permission prompt; `supported` becomes false if no events arrive.
 * `samples` keeps the last 2 s of readings with their event times, so the guide can look up where the
 * phone pointed when a given camera frame was captured (the camera image lags the sensor by ~50–150 ms).
 */
export function useOrientation(active: boolean) {
  const angles = useRef<DeviceAngles | null>(null);
  const samples = useRef<OrientationSample[]>([]);
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    const on = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const a = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, screenAngle: screen.orientation?.angle ?? 0 };
      angles.current = a;
      const now = performance.now();
      const buf = samples.current;
      buf.push({ t: now, a });
      while (buf.length && buf[0].t < now - 2000) buf.shift();
      setSupported(true);
    };
    window.addEventListener("deviceorientation", on);
    const timer = setTimeout(() => setSupported((s) => (s === null ? false : s)), 2500);
    return () => {
      window.removeEventListener("deviceorientation", on);
      clearTimeout(timer);
    };
  }, [active]);
  return { angles, samples, supported };
}

/** Readings per second over the buffered window (for diagnostics). */
/** Capture debugging is on with ?debug=1 in the URL (remembered on this phone until ?debug=0). */
export function captureDebug(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search).get("debug");
  try {
    if (q === "0") localStorage.removeItem("nz-debug");
    else if (q !== null) localStorage.setItem("nz-debug", "1");
    return localStorage.getItem("nz-debug") === "1";
  } catch {
    return q !== null && q !== "0";
  }
}

/** Report capture state to the server log (stalls, failures, and every second in debug mode). Never throws. */
export function sendCaptureDiag(body: Record<string, unknown>, token: string | null) {
  try {
    void fetch("/api/captures/diag", { method: "POST", keepalive: true, headers: { "content-type": "application/json", ...(token ? { "x-capture-token": token } : {}) }, body: JSON.stringify({ at: Date.now(), ...body }).slice(0, 3900) }).catch(() => {});
  } catch {}
}

/** Server error message including validation details, for showing to the user. */
export function uploadErrorText(data: { error?: string; details?: unknown }): string {
  const details = Array.isArray(data.details) ? data.details.filter((d) => typeof d === "string").slice(0, 3) : [];
  return `${data.error ?? "Upload failed"}${details.length ? ` (${details.join("; ")})` : ""}`;
}

/** A finite number within [lo, hi], or undefined (for optional diagnostics that must never fail an upload). */
export function finiteIn(v: number, lo: number, hi: number): number | undefined {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : undefined;
}

export function sensorRate(samples: OrientationSample[]): number {
  if (samples.length < 2) return 0;
  return ((samples.length - 1) * 1000) / (samples[samples.length - 1].t - samples[0].t);
}

/** Fallback camera latency when the browser does not report frame capture times. */
export const DEFAULT_CAMERA_LATENCY_MS = 90;
const MIN_PLAUSIBLE_CAMERA_LATENCY_MS = 25;

type FrameMeta = { captureTime?: number; expectedDisplayTime?: number };
type VideoWithRvfc = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number; cancelVideoFrameCallback?: (h: number) => void };

/**
 * Tracks when the frame currently on screen was captured by the camera (requestVideoFrameCallback's
 * captureTime). `sync` says whether the browser reported it or we estimate a fixed latency.
 */
export function useVideoFrameClock(videoRef: React.RefObject<HTMLVideoElement | null>, active: boolean) {
  const clock = useRef<{ captureTime: number | null; latencyMs: number; sync: "camera" | "estimated" }>({ captureTime: null, latencyMs: DEFAULT_CAMERA_LATENCY_MS, sync: "estimated" });
  useEffect(() => {
    const v = videoRef.current as VideoWithRvfc | null;
    if (!active || !v?.requestVideoFrameCallback) return;
    let handle = 0;
    const tick = (now: number, meta: FrameMeta) => {
      // A real camera pipeline takes ≥ 25 ms from exposure to screen. Some phones report a captureTime that is
      // ~0 ms old or even in the future (seen on a Nothing Phone (1)); using it draws the guide dots for the wrong
      // moment, so they slide off the room while turning. Such timestamps are ignored and a typical latency used.
      const lat = typeof meta.captureTime === "number" && meta.captureTime > 0 ? now - meta.captureTime : -1;
      if (lat >= MIN_PLAUSIBLE_CAMERA_LATENCY_MS && lat < 1000) {
        clock.current = { captureTime: meta.captureTime!, latencyMs: clock.current.sync === "camera" ? clock.current.latencyMs * 0.9 + lat * 0.1 : lat, sync: "camera" };
      } else clock.current = { captureTime: now - DEFAULT_CAMERA_LATENCY_MS, latencyMs: DEFAULT_CAMERA_LATENCY_MS, sync: "estimated" };
      handle = v.requestVideoFrameCallback!(tick);
    };
    handle = v.requestVideoFrameCallback(tick);
    return () => v.cancelVideoFrameCallback?.(handle);
  }, [videoRef, active]);
  /** Capture time of the frame on screen right now. */
  const frameTime = useCallback(() => {
    const c = clock.current;
    const est = performance.now() - c.latencyMs;
    // If the callback clock has gone stale (e.g. no new frames), fall back to the estimate.
    return c.captureTime !== null && est - c.captureTime < 250 ? c.captureTime : est;
  }, []);
  return { clock, frameTime };
}

/**
 * Grab the next camera frame together with its capture time, so the photo and its orientation tag refer
 * to the same instant.
 */
export function grabSyncedFrame(video: HTMLVideoElement, maxLong = 1600, quality = 0.88): Promise<{ blob: Blob; captureTime: number }> {
  const v = video as VideoWithRvfc;
  const draw = (captureTime: number) => {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(1, maxLong / Math.max(vw, vh));
    const c = document.createElement("canvas");
    c.width = Math.round(vw * s);
    c.height = Math.round(vh * s);
    c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
    return new Promise<{ blob: Blob; captureTime: number }>((res, rej) => c.toBlob((b) => (b ? res({ blob: b, captureTime }) : rej(new Error("capture failed"))), "image/jpeg", quality));
  };
  if (!v.requestVideoFrameCallback) return draw(performance.now() - DEFAULT_CAMERA_LATENCY_MS);
  return new Promise((resolve, reject) => {
    v.requestVideoFrameCallback!((now, meta) => {
      const lat = typeof meta.captureTime === "number" && meta.captureTime > 0 ? now - meta.captureTime : -1;
      const ct = lat >= MIN_PLAUSIBLE_CAMERA_LATENCY_MS && lat < 1000 ? meta.captureTime! : now - DEFAULT_CAMERA_LATENCY_MS;
      draw(ct).then(resolve, reject);
    });
  });
}

/** Must be called from a user gesture (iOS Safari). */
export async function requestOrientationPermission(): Promise<boolean> {
  const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (D?.requestPermission) {
    try {
      return (await D.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

export interface FrameQuality {
  brightness: number; // 0..255
  sharpness: number; // Laplacian variance at low resolution
  motion: number; // mean abs difference vs previous sample
}

/** Cheap live quality metrics from a 120×90 copy of the current video frame. */
export function useFrameQuality(videoRef: React.RefObject<HTMLVideoElement | null>, active: boolean) {
  const [q, setQ] = useState<FrameQuality | null>(null);
  useEffect(() => {
    if (!active) return;
    const c = document.createElement("canvas");
    c.width = 120;
    c.height = 90;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    let prev: Uint8ClampedArray | null = null;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v || !ctx || v.readyState < 2) return;
      ctx.drawImage(v, 0, 0, 120, 90);
      const d = ctx.getImageData(0, 0, 120, 90).data;
      const g = new Float32Array(120 * 90);
      let sum = 0;
      for (let i = 0; i < g.length; i++) {
        g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        sum += g[i];
      }
      let lsum = 0, lsq = 0, n = 0;
      for (let y = 1; y < 89; y++)
        for (let x = 1; x < 119; x++) {
          const i = y * 120 + x;
          const l = g[i - 1] + g[i + 1] + g[i - 120] + g[i + 120] - 4 * g[i];
          lsum += l;
          lsq += l * l;
          n++;
        }
      let motion = 0;
      if (prev) {
        for (let i = 0; i < d.length; i += 16) motion += Math.abs(d[i] - prev[i]);
        motion /= d.length / 16;
      }
      prev = new Uint8ClampedArray(d);
      setQ({ brightness: sum / g.length, sharpness: lsq / n - (lsum / n) ** 2, motion });
    }, 250);
    return () => clearInterval(id);
  }, [videoRef, active]);
  return q;
}

/** Grab the current video frame as a JPEG (long side ≤ maxLong). */
export async function grabFrame(video: HTMLVideoElement, maxLong = 2048, quality = 0.9): Promise<Blob> {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(1, maxLong / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.round(vw * s);
  c.height = Math.round(vh * s);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("capture failed"))), "image/jpeg", quality));
}

/** Upload with progress (fetch has no upload progress). */
export function uploadForm(url: string, fd: FormData, token: string | null, onProgress?: (p: number) => void): Promise<{ ok: boolean; data: { error?: string; [k: string]: unknown } }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (token) xhr.setRequestHeader("x-capture-token", token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
    };
    xhr.onerror = () => resolve({ ok: false, data: { error: "Network error: check your connection and retry" } });
    xhr.send(fd);
  });
}

export function pickRecorderMime(): string | undefined {
  const cands = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return cands.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m));
}

export function useInterval(cb: () => void, ms: number | null) {
  const saved = useRef(cb);
  saved.current = cb;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useStableCallback<T extends (...a: never[]) => unknown>(fn: T) {
  const r = useRef(fn);
  r.current = fn;
  return useCallback((...a: Parameters<T>) => r.current(...a), []) as T;
}
