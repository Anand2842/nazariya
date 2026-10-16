// Device-orientation math shared by the in-browser capture guide and the server-side stitcher.
//
// W3C DeviceOrientation: rotation from device frame to Earth frame is R = Rz(alpha)·Rx(beta)·Ry(gamma)
// (Earth frame: x = East, y = North, z = Up; device frame: x = right edge, y = top edge, z = out of the screen).
// The rear camera looks along −z_device. Tour space (see pano-geometry): x = right/East, y = Up, z = −North,
// yaw 0 looks toward −Z and positive yaw turns clockwise seen from above.
import type { Vec3 } from "./pano-geometry";

export interface Basis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export interface DeviceAngles {
  alpha: number; // degrees
  beta: number;
  gamma: number;
  screenAngle?: number; // screen.orientation.angle: 0 | 90 | 180 | 270
}

const D2R = Math.PI / 180;

function rotationMatrix(alpha: number, beta: number, gamma: number): number[][] {
  const [a, b, g] = [alpha * D2R, beta * D2R, gamma * D2R];
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // Rz(a)·Rx(b)·Ry(g)
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}

function mul(m: number[][], v: Vec3): Vec3 {
  return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
}

/** Camera basis in the Earth (ENU) frame for the rear camera, accounting for screen rotation. */
export function deviceBasisEarth(o: DeviceAngles): Basis {
  const m = rotationMatrix(o.alpha, o.beta, o.gamma);
  const th = (o.screenAngle ?? 0) * D2R;
  const upDev: Vec3 = [Math.sin(th), Math.cos(th), 0];
  const rightDev: Vec3 = [Math.cos(th), -Math.sin(th), 0];
  return { forward: mul(m, [0, 0, -1]), up: mul(m, upDev), right: mul(m, rightDev) };
}

/** ENU → tour space (x = E, y = U, z = −N). */
export function earthToTour(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

/** Yaw (radians, clockwise from −Z) of a tour-space vector. */
export function yawOf(v: Vec3): number {
  return Math.atan2(v[0], -v[2]);
}

export function pitchOf(v: Vec3): number {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return Math.asin(Math.max(-1, Math.min(1, v[1] / n)));
}

/** Rotate a tour-space vector about the vertical axis so that yaw increases by `phi`. */
export function rotateYaw(v: Vec3, phi: number): Vec3 {
  const c = Math.cos(phi), s = Math.sin(phi);
  return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
}

/** Tour-space camera basis relative to a reference heading (the first shot defines yaw 0). */
export function tourBasis(o: DeviceAngles, headingRef: number): Basis {
  const e = deviceBasisEarth(o);
  const f = (v: Vec3) => rotateYaw(earthToTour(v), -headingRef);
  return { forward: f(e.forward), right: f(e.right), up: f(e.up) };
}

export function headingOf(o: DeviceAngles): number {
  return yawOf(earthToTour(deviceBasisEarth(o).forward));
}

/** Roll of the camera around its forward axis (0 = level), radians. */
export function rollOf(b: Basis): number {
  // Project world-up onto the image plane; angle between it and camera-up.
  const worldUp: Vec3 = [0, 1, 0];
  const x = dot(worldUp, b.right);
  const y = dot(worldUp, b.up);
  return Math.atan2(x, y);
}

export function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function angleBetween(a: Vec3, b: Vec3) {
  const n = (Math.hypot(...a) || 1) * (Math.hypot(...b) || 1);
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / n)));
}

export interface Target {
  id: number;
  yaw: number; // radians
  pitch: number;
  ring: "horizon" | "up" | "down" | "zenith" | "nadir";
}

/** Capture plan for a phone camera held upright (portrait): 12 + 8 + 8 + zenith + nadir = 30 shots. */
export function panoTargets(): Target[] {
  const t: Target[] = [];
  let id = 0;
  for (let k = 0; k < 12; k++) t.push({ id: id++, yaw: k * 30 * D2R, pitch: 0, ring: "horizon" });
  for (let k = 0; k < 8; k++) t.push({ id: id++, yaw: (k * 45 + 22.5) * D2R, pitch: 45 * D2R, ring: "up" });
  for (let k = 0; k < 8; k++) t.push({ id: id++, yaw: (k * 45 + 22.5) * D2R, pitch: -45 * D2R, ring: "down" });
  t.push({ id: id++, yaw: 0, pitch: 88 * D2R, ring: "zenith" });
  t.push({ id: id++, yaw: 0, pitch: -88 * D2R, ring: "nadir" });
  return t;
}

/** Device angles that point the rear camera at (yaw, pitch) relative to heading `alpha0` (for tests & simulators). */
export function anglesFor(yawDeg: number, pitchDeg: number, alpha0 = 0): DeviceAngles {
  // Upright portrait: beta = 90 + pitch tilts the camera up; alpha rotates counter-clockwise, i.e. heading = −alpha.
  return { alpha: (((alpha0 - yawDeg) % 360) + 360) % 360, beta: 90 + pitchDeg, gamma: 0, screenAngle: 0 };
}

// ---------------- Time-synchronised orientation (capture guide) ----------------

/** One orientation reading with its event time (performance.now() clock, ms). */
export interface OrientationSample {
  t: number;
  a: DeviceAngles;
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Index of the sample closest in time to `t` (samples are in time order). */
export function nearestSample(samples: OrientationSample[], t: number): number {
  if (!samples.length) return -1;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(samples[lo].t - t) <= Math.abs(samples[hi].t - t) ? lo : hi;
}

/**
 * Camera basis at time `t`, interpolated between the two neighbouring readings. Interpolating the basis
 * vectors (not the Euler angles) stays correct near beta = 90°, where an upright phone's alpha/gamma swing wildly.
 */
export function basisAt(samples: OrientationSample[], t: number, headingRef: number): Basis | null {
  if (!samples.length) return null;
  let i = nearestSample(samples, t);
  if (samples[i].t > t && i > 0) i--;
  const a = samples[i], b = samples[Math.min(samples.length - 1, i + 1)];
  const ba = tourBasis(a.a, headingRef);
  if (b === a || b.t <= a.t || t <= a.t) return ba;
  const bb = tourBasis(b.a, headingRef);
  const w = Math.min(1, (t - a.t) / (b.t - a.t));
  const mix = (x: Vec3, y: Vec3): Vec3 => [x[0] + (y[0] - x[0]) * w, x[1] + (y[1] - x[1]) * w, x[2] + (y[2] - x[2]) * w];
  const forward = normalize(mix(ba.forward, bb.forward));
  const right = normalize(cross(forward, mix(ba.up, bb.up)));
  return { forward, right, up: cross(right, forward) };
}

/**
 * How far the camera wandered (degrees) during the last `windowMs`: the largest angle between any reading in
 * the window and the newest one, over the forward and up axes (catches turning and twisting). Robust to the
 * ~0.1° per-reading sensor noise that would make a reading-to-reading speed look large.
 */
export function angularSpreadDeg(samples: OrientationSample[], now: number, windowMs = 300): number {
  const recent = samples.filter((s) => s.t >= now - windowMs && s.t <= now + 1);
  if (recent.length < 2) return Infinity;
  const last = deviceBasisEarth(recent[recent.length - 1].a);
  let worst = 0;
  for (let k = 0; k < recent.length - 1; k++) {
    const b = deviceBasisEarth(recent[k].a);
    worst = Math.max(worst, angleBetween(b.forward, last.forward), angleBetween(b.up, last.up));
  }
  return worst * (180 / Math.PI);
}

export function targetDir(t: Target): Vec3 {
  return [Math.sin(t.yaw) * Math.cos(t.pitch), Math.sin(t.pitch), -Math.cos(t.yaw) * Math.cos(t.pitch)];
}

const RING_SEQUENCE: Target["ring"][] = ["horizon", "up", "down", "zenith", "nadir"];

/**
 * The single next target to show: finish one row at a time, moving clockwise (to the right) from the last
 * shot, so the user never has to choose between two dots. A new row starts at the dot closest to where the
 * camera points.
 */
export function nextTarget(targets: Target[], done: Set<number>, lastYaw: number | null, currentYaw: number): Target | null {
  const ring = RING_SEQUENCE.find((r) => targets.some((t) => t.ring === r && !done.has(t.id)));
  if (!ring) return null;
  const open = targets.filter((t) => t.ring === ring && !done.has(t.id));
  const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sameRingDone = targets.some((t) => t.ring === ring && done.has(t.id));
  if (sameRingDone && lastYaw !== null) {
    // Continue clockwise: smallest positive yaw step from the last shot.
    return open.reduce((best, t) => (wrap(t.yaw - lastYaw) < wrap(best.yaw - lastYaw) ? t : best));
  }
  const dist = (t: Target) => Math.min(wrap(t.yaw - currentYaw), wrap(currentYaw - t.yaw));
  return open.reduce((best, t) => (dist(t) < dist(best) ? t : best));
}
