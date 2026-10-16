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
