"use client";
// WebXR "immersive-ar" glue for depth-mode capture (Android Chrome with ARCore; phones with a depth/ToF
// sensor use it, others get depth estimated from motion). Gives the capture screen, every frame:
//   • the camera pose from AR tracking (position + orientation, no compass drift),
//   • on request: the camera image (raw camera access) and depth points in world coordinates.
// Browsers do not expose iPhone LiDAR; on iOS and desktop this reports "unsupported" and the standard
// gyroscope capture is used instead.

/* eslint-disable @typescript-eslint/no-explicit-any */
type XRSystemLike = { isSessionSupported(mode: string): Promise<boolean>; requestSession(mode: string, init: Record<string, unknown>): Promise<any> };

export interface ArFrame {
  t: number;
  /** Camera-to-world matrix (column-major), AR world in metres, y up. */
  matrix: Float32Array;
  projection: Float32Array;
  /** Tracking is degraded (position estimated): don't trust positions. */
  limited: boolean;
}

export interface ArCaptureResult {
  frame: ArFrame;
  image: ImageData | null;
}

export interface ArFeatures {
  depth: boolean;
  camera: boolean;
  localFloor: boolean;
}

export interface ArStats {
  /** XR frames per second over the last second. */
  fps: number;
  pendingImages: number;
  pendingDepth: number;
  /** Last error thrown while reading the camera image or depth (requests are retried, never dropped). */
  lastError: string | null;
}

export interface ArSession {
  features: ArFeatures;
  stats(): ArStats;
  /** Called on every AR frame. */
  onFrame(cb: (f: ArFrame) => void): void;
  /** Camera image of the next frame (null if camera access is unavailable). */
  captureImage(maxLong?: number): Promise<ArCaptureResult>;
  /** Depth points of the next frame, world coordinates (x,y,z triples), sampled on a grid. */
  sampleDepth(cols?: number, rows?: number): Promise<Float32Array | null>;
  end(): Promise<void>;
  onEnd(cb: () => void): void;
  /** AR tracking re-based its world origin (positions jump); the browser fires this on the reference space. */
  onReset(cb: () => void): void;
}

function xr(): XRSystemLike | null {
  return typeof navigator !== "undefined" ? ((navigator as any).xr ?? null) : null;
}

/** Whether this browser can run an AR session (depth/camera support is only known once it starts). */
export async function arSupported(): Promise<boolean> {
  try {
    const x = xr();
    if (!x || !window.isSecureContext) return false;
    return await x.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

export function isIos() {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** Must be called from a user gesture. `overlay` stays visible on top of the camera view (DOM overlay). */
export async function startArSession(overlay: HTMLElement): Promise<ArSession> {
  const system = xr();
  if (!system) throw new Error("AR is not available in this browser");
  const session = await system.requestSession("immersive-ar", {
    requiredFeatures: ["local"],
    optionalFeatures: ["depth-sensing", "camera-access", "dom-overlay", "local-floor"],
    domOverlay: { root: overlay },
    depthSensing: { usagePreference: ["cpu-optimized"], dataFormatPreference: ["luminance-alpha", "float32"] },
  });
  const canvas = document.createElement("canvas");
  const gl = (canvas.getContext("webgl2", { xrCompatible: true, alpha: true }) ?? canvas.getContext("webgl", { xrCompatible: true, alpha: true })) as WebGL2RenderingContext | null;
  if (!gl) {
    await session.end();
    throw new Error("WebGL is not available");
  }
  // The context was requested xrCompatible; don't let a slow makeXRCompatible() hang the start.
  await Promise.race([(gl as any).makeXRCompatible?.(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
  const W = window as any;
  session.updateRenderState({ baseLayer: new W.XRWebGLLayer(session, gl) });
  let refSpace: any;
  let localFloor = false;
  try {
    refSpace = await session.requestReferenceSpace("local-floor");
    localFloor = true;
  } catch {
    refSpace = await session.requestReferenceSpace("local");
  }
  const enabled: string[] = Array.from(session.enabledFeatures ?? []);
  const depth = enabled.includes("depth-sensing") || session.depthUsage === "cpu-optimized";
  const camera = enabled.includes("camera-access") && typeof W.XRWebGLBinding === "function";
  const binding = camera ? new W.XRWebGLBinding(session, gl) : null;
  const fb = gl.createFramebuffer();

  const frameCbs: ((f: ArFrame) => void)[] = [];
  const endCbs: (() => void)[] = [];
  const resetCbs: (() => void)[] = [];
  refSpace.addEventListener?.("reset", () => resetCbs.forEach((c) => c()));
  // Several parts of the app may ask for the next frame's image/depth at once: queue, never overwrite.
  // A request is answered on the first frame that can serve it. Frames without a camera image, or a read that
  // throws, keep it queued for a later frame (up to MAX_TRIES), so a caller can never wait forever.
  const MAX_TRIES = 45;
  let imageReqs: { maxLong: number; tries: number; resolve: (r: ArCaptureResult) => void }[] = [];
  let depthReqs: { cols: number; rows: number; tries: number; resolve: (p: Float32Array | null) => void }[] = [];
  let lastError: string | null = null;
  const frameTimes: number[] = [];
  let ended = false;
  session.addEventListener("end", () => {
    ended = true;
    imageReqs.forEach((r) => r.resolve({ frame: { t: 0, matrix: new Float32Array(16), projection: new Float32Array(16), limited: true }, image: null }));
    depthReqs.forEach((r) => r.resolve(null));
    imageReqs = [];
    depthReqs = [];
    endCbs.forEach((c) => c());
  });

  const readCamera = (view: any, maxLong: number): ImageData | null => {
    if (!binding || !view.camera) return null;
    const tex = binding.getCameraImage(view.camera);
    if (!tex) return null;
    const w = view.camera.width, h = view.camera.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const buf = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL rows are bottom-up; downscale (nearest) to maxLong while flipping.
    const s = Math.min(1, maxLong / Math.max(w, h));
    const ow = Math.round(w * s), oh = Math.round(h * s);
    const out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < oh; y++) {
      const sy = h - 1 - Math.min(h - 1, Math.floor(y / s));
      for (let x = 0; x < ow; x++) {
        const sx = Math.min(w - 1, Math.floor(x / s));
        const i = (sy * w + sx) * 4, o = (y * ow + x) * 4;
        out[o] = buf[i];
        out[o + 1] = buf[i + 1];
        out[o + 2] = buf[i + 2];
        out[o + 3] = 255;
      }
    }
    return new ImageData(out, ow, oh);
  };

  const readDepth = (frame: any, view: any, cols: number, rows: number): Float32Array | null => {
    if (!depth) return null;
    let info: any = null;
    try {
      info = frame.getDepthInformation(view);
    } catch {
      return null;
    }
    if (!info) return null;
    const P = view.projectionMatrix, M = view.transform.matrix;
    const pts: number[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) / cols, y = (r + 0.5) / rows;
        const z = info.getDepthInMeters(x, y);
        if (!(z > 0.2 && z < 8)) continue;
        // Normalised view coords → camera space (camera looks down −z), then → world.
        const X = ((2 * x - 1 + P[8]) * z) / P[0], Y = ((1 - 2 * y + P[9]) * z) / P[5], Z = -z;
        pts.push(M[0] * X + M[4] * Y + M[8] * Z + M[12], M[1] * X + M[5] * Y + M[9] * Z + M[13], M[2] * X + M[6] * Y + M[10] * Z + M[14]);
      }
    return Float32Array.from(pts);
  };

  const onXRFrame = (t: number, frame: any) => {
    if (ended) return;
    session.requestAnimationFrame(onXRFrame);
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pose = frame.getViewerPose(refSpace);
    if (!pose?.views?.length) return;
    const view = pose.views[0];
    const f: ArFrame = { t, matrix: Float32Array.from(view.transform.matrix), projection: Float32Array.from(view.projectionMatrix), limited: !!pose.emulatedPosition };
    frameTimes.push(t);
    while (frameTimes.length && frameTimes[0] < t - 1000) frameTimes.shift();
    if (imageReqs.length) {
      // One camera read per frame, at the largest size anyone asked for.
      const maxLong = Math.max(...imageReqs.map((r) => r.maxLong));
      let img: ImageData | null = null;
      try {
        img = readCamera(view, maxLong);
      } catch (e) {
        lastError = `camera: ${(e as Error).message}`;
      }
      const reqs = imageReqs;
      imageReqs = [];
      for (const r of reqs) {
        if (img) r.resolve({ frame: f, image: r.maxLong < maxLong ? downscaleImage(img, r.maxLong) : img });
        else if (++r.tries < MAX_TRIES) imageReqs.push(r);
        else r.resolve({ frame: f, image: null });
      }
    }
    if (depthReqs.length) {
      const reqs = depthReqs;
      depthReqs = [];
      for (const r of reqs) {
        let pts: Float32Array | null = null;
        try {
          pts = readDepth(frame, view, r.cols, r.rows);
        } catch (e) {
          lastError = `depth: ${(e as Error).message}`;
        }
        if (pts || ++r.tries >= MAX_TRIES) r.resolve(pts);
        else depthReqs.push(r);
      }
    }
    try {
      frameCbs.forEach((c) => c(f));
    } catch (e) {
      lastError = `frame: ${(e as Error).message}`;
    }
  };
  session.requestAnimationFrame(onXRFrame);

  return {
    features: { depth, camera, localFloor },
    stats: () => ({ fps: frameTimes.length, pendingImages: imageReqs.length, pendingDepth: depthReqs.length, lastError }),
    onFrame: (cb) => frameCbs.push(cb),
    captureImage: (maxLong = 1600) => new Promise((resolve) => (ended ? resolve({ frame: { t: 0, matrix: new Float32Array(16), projection: new Float32Array(16), limited: true }, image: null }) : imageReqs.push({ maxLong, tries: 0, resolve }))),
    sampleDepth: (cols = 40, rows = 30) => new Promise((resolve) => (ended ? resolve(null) : depthReqs.push({ cols, rows, tries: 0, resolve }))),
    end: async () => {
      if (!ended) await session.end();
    },
    onEnd: (cb) => endCbs.push(cb),
    onReset: (cb) => resetCbs.push(cb),
  };
}

function downscaleImage(img: ImageData, maxLong: number): ImageData {
  const s = maxLong / Math.max(img.width, img.height);
  const w = Math.round(img.width * s), h = Math.round(img.height * s);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (Math.min(img.height - 1, Math.floor(y / s)) * img.width + Math.min(img.width - 1, Math.floor(x / s))) * 4, o = (y * w + x) * 4;
      out[o] = img.data[i];
      out[o + 1] = img.data[i + 1];
      out[o + 2] = img.data[i + 2];
      out[o + 3] = 255;
    }
  return new ImageData(out, w, h);
}

/** JPEG from captured camera pixels. */
export function imageDataToJpeg(img: ImageData, quality = 0.88): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality));
}
