// WebXR pose helpers shared by the AR capture screen and the server.
// WebXR reference spaces are y-up, metres; the camera looks along its local −z with +y up. That matches tour
// space (x right, y up, yaw 0 towards −z), so AR world coordinates map to tour coordinates directly.
import type { Basis } from "./orientation";
import type { Vec3 } from "./pano-geometry";

/** Camera basis and position from a camera-to-world matrix (column-major, as XRRigidTransform.matrix). */
export function poseFromMatrix(m: ArrayLike<number>): { basis: Basis; position: Vec3 } {
  return {
    basis: { right: [m[0], m[1], m[2]], up: [m[4], m[5], m[6]], forward: [-m[8], -m[9], -m[10]] },
    position: [m[12], m[13], m[14]],
  };
}

/**
 * Where to move the phone to get back to `target`, in the user's own terms (metres): right/left along the
 * screen's horizontal, forward/back along the direction the user faces, up/down. Works when the camera points up
 * or down too (then the user's "forward" is the top edge of the phone, or its bottom edge).
 */
export function moveHint(position: Vec3, target: Vec3, b: Basis): { right: number; forward: number; up: number } {
  const o: Vec3 = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const flat = (v: Vec3): Vec3 => {
    const n = Math.hypot(v[0], v[2]) || 1;
    return [v[0] / n, 0, v[2] / n];
  };
  const right = flat(b.right);
  // Facing direction: the camera's horizontal heading; tilted up it is the phone's bottom edge, tilted down its top edge.
  const f = flat([b.forward[0] - b.forward[1] * b.up[0], 0, b.forward[2] - b.forward[1] * b.up[2]]);
  return { right: o[0] * right[0] + o[2] * right[2], forward: o[0] * f[0] + o[2] * f[2], up: o[1] };
}

/** "9 cm left, 5 cm down" (components under 3 cm are left out). */
export function moveHintText(h: { right: number; forward: number; up: number }): string {
  const part = (v: number, pos: string, neg: string) => (Math.abs(v) >= 0.03 ? `${Math.round(Math.abs(v) * 100)} cm ${v > 0 ? pos : neg}` : null);
  const parts = [part(h.right, "right", "left"), part(h.forward, "forward", "back"), part(h.up, "up", "down")].filter(Boolean);
  return parts.length ? parts.join(", ") : "a little";
}

/** Yaw (radians, clockwise from −z) of a direction. */
export function yawOfDir(v: Vec3): number {
  return Math.atan2(v[0], -v[2]);
}

/** Rotate a vector about world-up so its yaw increases by `phi` (radians). */
export function rotY(v: Vec3, phi: number): Vec3 {
  const c = Math.cos(phi), s = Math.sin(phi);
  return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
}

/** Express a world-space basis in a room frame whose yaw 0 is world heading `headingRef`. */
export function basisInRoom(b: Basis, headingRef: number): Basis {
  return { forward: rotY(b.forward, -headingRef), right: rotY(b.right, -headingRef), up: rotY(b.up, -headingRef) };
}

/** World point → room-local (origin at the capture point, yaw 0 = `headingRef`). */
export function pointInRoom(p: Vec3, origin: Vec3, headingRef: number): Vec3 {
  return rotY([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], -headingRef);
}

/**
 * Pinhole intrinsics from a WebXR projection matrix for an image of `width`×`height` pixels.
 * fx = P[0]·w/2, fy = P[5]·h/2; principal point from P[8], P[9].
 */
export function intrinsicsFromProjection(p: ArrayLike<number>, width: number, height: number) {
  return { fx: (p[0] * width) / 2, fy: (p[5] * height) / 2, cx: ((1 - p[8]) * width) / 2, cy: ((1 + p[9]) * height) / 2, width, height };
}

/** Long-side field of view (degrees) for the stitcher. */
export function fovLongDeg(k: { fx: number; fy: number; width: number; height: number }): number {
  const long = k.width >= k.height ? { size: k.width, f: k.fx } : { size: k.height, f: k.fy };
  return (2 * Math.atan(long.size / 2 / long.f) * 180) / Math.PI;
}
