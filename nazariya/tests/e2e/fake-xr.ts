/**
 * A simulated AR phone for browser tests: a WebXR "immersive-ar" implementation backed by a synthetic,
 * textured two-room flat. It answers camera poses (set by the test via window.__xr), depth readings
 * (ray-cast distances) and camera images (rendered from the same geometry), like ARCore would.
 * Installed with page.addInitScript(installFakeXR) — must be self-contained.
 */
export function installFakeXR() {
  type V = [number, number, number];
  const W = window as unknown as Record<string, unknown>;
  // The flat: room A (3.6 × 4.2 m) and room B (3.2 × 3.2 m) side by side, a doorway between them.
  const FLOOR = -1.4, CEIL = 1.4;
  const A = { x0: -1.8, x1: 1.8, z0: -2.1, z1: 2.1 };
  const B = { x0: 1.9, x1: 5.1, z0: -1.6, z1: 1.6 };
  const DOOR = { z0: -0.45, z1: 0.45, top: 0.7 };
  // flaky: behave like a real phone under load: some frames have no camera image, and camera/depth reads
  // occasionally throw. A capture must survive this.
  // drift: error added to the *reported* position only (the camera still sees the real room), like visual-inertial
  // tracking slipping on a plain ceiling.
  const state = { pos: [0, 0, 0] as V, yaw: 0, pitch: 0, flaky: false, drift: [0, 0, 0] as V };
  let frameNo = 0, cameraReads = 0;
  W.__xr = state;

  const exitBox = (o: V, d: V, b: typeof A) => {
    let t = Infinity, n = 0;
    const tryT = (tt: number, nn: number) => {
      if (tt > 1e-6 && tt < t) [t, n] = [tt, nn];
    };
    if (d[0]) tryT(((d[0] > 0 ? b.x1 : b.x0) - o[0]) / d[0], 0);
    if (d[1]) tryT(((d[1] > 0 ? CEIL : FLOOR) - o[1]) / d[1], 1);
    if (d[2]) tryT(((d[2] > 0 ? b.z1 : b.z0) - o[2]) / d[2], 2);
    return { t, n };
  };
  /** Distance to the first surface and the surface's axis (0 wall x, 1 floor/ceiling, 2 wall z). */
  const cast = (o: V, d: V): { t: number; n: number } => {
    const inA = o[0] < 1.85;
    const box = inA ? A : B;
    const h = exitBox(o, d, box);
    const p: V = [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t];
    const onDoorWall = h.n === 0 && Math.abs(p[0] - (inA ? A.x1 : B.x0)) < 1e-3;
    if (onDoorWall && p[2] > DOOR.z0 && p[2] < DOOR.z1 && p[1] < DOOR.top) {
      const q: V = [p[0] + d[0] * 0.12, p[1] + d[1] * 0.12, p[2] + d[2] * 0.12];
      const h2 = exitBox(q, d, inA ? B : A);
      return { t: h.t + 0.12 + h2.t, n: h2.n };
    }
    return h;
  };
  /** Procedural texture: distinct, detailed surfaces so photos can be stitched. */
  const shade = (p: V, n: number): [number, number, number] => {
    const s = (a: number, b: number) => 0.5 + 0.25 * Math.sin(a * 9.1 + Math.sin(b * 3.3) * 2) * Math.sin(b * 7.7 + a * 1.3) + 0.25 * Math.sin(a * 23 + b * 17);
    if (n === 1) {
      const v = s(p[0], p[2]);
      return p[1] < 0 ? [150 * v + 60, 95 * v + 40, 60 * v + 20] : [230 * v + 20, 230 * v + 20, 225 * v + 20];
    }
    const u = n === 0 ? p[2] : p[0];
    const v = s(u, p[1]);
    const hue = n === 0 ? (p[0] > 3 ? [120, 170, 220] : [220, 170, 130]) : p[2] > 0 ? [170, 210, 160] : [210, 190, 220];
    return [hue[0] * v + 30, hue[1] * v + 30, hue[2] * v + 30];
  };

  const basis = () => {
    const { yaw, pitch } = state;
    const f: V = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const r: V = [Math.cos(yaw), 0, Math.sin(yaw)];
    const u: V = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { f, r, u };
  };
  const CAM_W = 360, CAM_H = 640;
  const fy = 1 / Math.tan((64 / 2) * (Math.PI / 180));
  const fx = fy / (CAM_W / CAM_H);
  const projection = new Float32Array([fx, 0, 0, 0, 0, fy, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0]);

  const makeView = () => {
    const { f, r, u } = basis();
    const p = state.pos;
    const d = state.drift;
    const matrix = new Float32Array([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, p[0] + d[0], p[1] + d[1], p[2] + d[2], 1]);
    const camera = state.flaky && frameNo % 3 === 0 ? undefined : { width: CAM_W, height: CAM_H, __pose: { f, r, u, p: [...p] as V } };
    return { transform: { matrix }, projectionMatrix: projection, camera };
  };

  class FakeSession extends EventTarget {
    enabledFeatures = ["local", "depth-sensing", "camera-access", "dom-overlay"];
    depthUsage = "cpu-optimized";
    renderState: Record<string, unknown> = {};
    ended = false;
    updateRenderState(s: Record<string, unknown>) {
      this.renderState = { ...this.renderState, ...s };
    }
    async requestReferenceSpace(type: string) {
      if (type === "local-floor") throw new Error("not supported");
      return { type };
    }
    requestAnimationFrame(cb: (t: number, frame: unknown) => void) {
      return requestAnimationFrame((t) => {
        if (this.ended) return;
        frameNo++;
        const view = makeView();
        const pose = { f: [0, 0, 0] as V, r: [0, 0, 0] as V, u: [0, 0, 0] as V, p: [0, 0, 0] as V, ...(view.camera?.__pose ?? {}) };
        if (!view.camera) Object.assign(pose, basis(), { p: [...state.pos] });
        const depthFails = state.flaky && frameNo % 5 === 0;
        cb(t, {
          getViewerPose: () => ({ emulatedPosition: false, views: [view] }),
          getDepthInformation: () => ({
            width: 160,
            height: 120,
            getDepthInMeters: (x: number, y: number) => {
              if (depthFails) throw new DOMException("Depth data is not available for this frame", "InvalidStateError");
              const { f, r, u, p } = pose;
              const X = (2 * x - 1) / fx, Y = (1 - 2 * y) / fy;
              const d: V = [r[0] * X + u[0] * Y + f[0], r[1] * X + u[1] * Y + f[1], r[2] * X + u[2] * Y + f[2]];
              const len = Math.hypot(...d);
              const hit = cast(p, [d[0] / len, d[1] / len, d[2] / len]);
              return hit.t / len; // z-depth along the optical axis
            },
          }),
        });
      });
    }
    async end() {
      this.ended = true;
      this.dispatchEvent(new Event("end"));
    }
  }

  W.XRWebGLLayer = class {
    framebuffer = null;
    constructor() {}
  };
  W.XRWebGLBinding = class {
    gl: WebGLRenderingContext;
    constructor(_s: unknown, gl: WebGLRenderingContext) {
      this.gl = gl;
    }
    getCameraImage(camera: { width: number; height: number; __pose: { f: V; r: V; u: V; p: V } }) {
      if (state.flaky && ++cameraReads % 4 === 0) throw new DOMException("Camera image is not available", "InvalidStateError");
      const { f, r, u, p } = camera.__pose;
      const w = camera.width, h = camera.height;
      const px = new Uint8Array(w * h * 4);
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const X = ((2 * (i + 0.5)) / w - 1) / fx, Y = (1 - (2 * (j + 0.5)) / h) / fy;
          const d: V = [r[0] * X + u[0] * Y + f[0], r[1] * X + u[1] * Y + f[1], r[2] * X + u[2] * Y + f[2]];
          const len = Math.hypot(...d);
          const dn: V = [d[0] / len, d[1] / len, d[2] / len];
          const hit = cast(p, dn);
          const c = shade([p[0] + dn[0] * hit.t, p[1] + dn[1] * hit.t, p[2] + dn[2] * hit.t], hit.n);
          // GL textures are bottom-up.
          const o = ((h - 1 - j) * w + i) * 4;
          px[o] = c[0];
          px[o + 1] = c[1];
          px[o + 2] = c[2];
          px[o + 3] = 255;
        }
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return tex;
    }
  };
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) (C.prototype as unknown as { makeXRCompatible: () => Promise<void> }).makeXRCompatible = async () => {};
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: {
      isSessionSupported: async (mode: string) => mode === "immersive-ar",
      requestSession: async () => new FakeSession(),
    },
  });
}
