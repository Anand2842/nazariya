// Geometry shared by the panorama viewer, the 3D (splat) viewer and the pano→splat generator.
// Tour space: three.js convention, Y up, camera at the origin (eye height camH above the floor),
// yaw 0 looks toward -Z, positive yaw turns right (clockwise seen from above), pitch up is positive.
//
// A room is approximated as a box of width w (X), depth d (Z) and height h. Without measurements it is
// centred on the camera and aligned with the panorama: an *assumption* that gives panoramas depth, with
// arbitrary scale. With depth-sensing capture the box is measured: its centre may be offset from the
// camera (cx, cz) and rotated (rotDeg, same sense as yaw) to match the real walls, and `measured` is true.

export interface RoomDims {
  w: number;
  d: number;
  h: number;
  camH: number;
  cx?: number; // box centre relative to the camera (metres, room-local)
  cz?: number;
  rotDeg?: number; // box axes relative to the panorama's axes
  measured?: boolean; // from phone depth sensing (metric), not assumed
}

export type Vec3 = [number, number, number];

export function dirFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

export function yawPitchFromDir([x, y, z]: Vec3): { yaw: number; pitch: number } {
  const len = Math.hypot(x, y, z) || 1;
  return { yaw: Math.atan2(x, -z), pitch: Math.asin(Math.max(-1, Math.min(1, y / len))) };
}

/** Equirectangular pixel (u,v in [0,1]) to yaw/pitch. u=0.5 is yaw 0 (panorama centre). */
export function uvToYawPitch(u: number, v: number): { yaw: number; pitch: number } {
  return { yaw: (u - 0.5) * 2 * Math.PI, pitch: (0.5 - v) * Math.PI };
}

/** A room-local direction expressed in the (possibly rotated) box axes. */
export function toBoxFrame(v: Vec3, room: RoomDims): Vec3 {
  const r = ((room.rotDeg ?? 0) * Math.PI) / 180;
  if (!r) return v;
  // Undo the box rotation (rotation by −rotDeg in yaw sense).
  const c = Math.cos(-r), s = Math.sin(-r);
  return [v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c];
}

/** Distance along a ray from the camera to the inside of the room box, plus the hit plane normal axis (box axes). */
export function rayRoomHit(dir: Vec3, room: RoomDims): { t: number; axis: 0 | 1 | 2 } {
  const hx = room.w / 2;
  const hz = room.d / 2;
  const yFloor = -room.camH;
  const yCeil = room.h - room.camH;
  // Ray origin (the camera) and direction in box coordinates.
  const [ox, , oz] = toBoxFrame([-(room.cx ?? 0), 0, -(room.cz ?? 0)], room);
  const [dx, dy, dz] = toBoxFrame(dir, room);
  let t = Infinity;
  let axis: 0 | 1 | 2 = 0;
  if (dx !== 0) {
    const tx = ((dx > 0 ? hx : -hx) - ox) / dx;
    if (tx > 0 && tx < t) {
      t = tx;
      axis = 0;
    }
  }
  if (dy !== 0) {
    const ty = (dy > 0 ? yCeil : yFloor) / dy;
    if (ty > 0 && ty < t) {
      t = ty;
      axis = 1;
    }
  }
  if (dz !== 0) {
    const tz = ((dz > 0 ? hz : -hz) - oz) / dz;
    if (tz > 0 && tz < t) {
      t = tz;
      axis = 2;
    }
  }
  return { t, axis };
}

export function positionFromYawPitch(yaw: number, pitch: number, room: RoomDims, inset = 0.02): Vec3 {
  const d = dirFromYawPitch(yaw, pitch);
  const { t } = rayRoomHit(d, room);
  const tt = Math.max(0.05, t - inset);
  return [d[0] * tt, d[1] * tt, d[2] * tt];
}

export function validateRoomDims(r: Partial<RoomDims>): RoomDims {
  const clamp = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const h = clamp(r.h, 2.2, 6, 2.9);
  const w = clamp(r.w, 1.5, 20, 4), d = clamp(r.d, 1.5, 20, 4.5);
  const out: RoomDims = { w, d, h, camH: clamp(r.camH, 0.8, h - 0.3, 1.5) };
  // The camera must stay inside the box.
  if (r.cx !== undefined) out.cx = clamp(r.cx, -w / 2 + 0.2, w / 2 - 0.2, 0);
  if (r.cz !== undefined) out.cz = clamp(r.cz, -d / 2 + 0.2, d / 2 - 0.2, 0);
  if (r.rotDeg !== undefined) out.rotDeg = ((clamp(r.rotDeg, -720, 720, 0) % 360) + 360) % 360;
  if (r.measured) out.measured = true;
  return out;
}
