// Floor-plan geometry shared by the studio editor, the viewer minimap and the server.
//
// Plan space is a top-down 2D map in metres: (x, z) with the same axes as tour space (x right, z towards
// the viewer, "north" = −z). A room is placed by its capture point (x, z) and `rotDeg`: the plan heading
// of the room panorama's yaw 0 (same sense as yaw: clockwise seen from above).
import type { RoomDims } from "./pano-geometry";

export interface PlanPlacement {
  x: number;
  z: number;
  rotDeg: number;
  source: "manual" | "ar";
  sessionId?: string;
}

export type P2 = [number, number];

const D2R = Math.PI / 180;

/** Rotate a 2D (x, z) vector so its yaw increases by `deg`. */
export function rotate2(p: P2, deg: number): P2 {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/** Room-local (x, z) → plan (x, z). */
export function localToPlan(p: P2, plan: PlanPlacement): P2 {
  const r = rotate2(p, plan.rotDeg);
  return [plan.x + r[0], plan.z + r[1]];
}

/** Plan (x, z) → room-local (x, z). */
export function planToLocal(p: P2, plan: PlanPlacement): P2 {
  return rotate2([p[0] - plan.x, p[1] - plan.z], -plan.rotDeg);
}

/** Yaw (radians, room panorama frame) of the direction from the capture point to a room-local point. */
export function yawToLocal(p: P2): number {
  return Math.atan2(p[0], -p[1]);
}

/** The room's box outline (4 corners) in room-local coordinates. */
export function roomOutlineLocal(d: RoomDims): P2[] {
  const hx = d.w / 2, hz = d.d / 2;
  const corners: P2[] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  return corners.map((c) => {
    const r = rotate2(c, d.rotDeg ?? 0);
    return [r[0] + (d.cx ?? 0), r[1] + (d.cz ?? 0)];
  });
}

export function roomOutlinePlan(d: RoomDims, plan: PlanPlacement): P2[] {
  return roomOutlineLocal(d).map((p) => localToPlan(p, plan));
}

export function polygonArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

export function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function segmentIntersection(a: P2, b: P2, c: P2, d: P2): P2 | null {
  const r: P2 = [b[0] - a[0], b[1] - a[1]], s: P2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}

/** Where a walked path first leaves a room outline (the doorway), or null if it never does. */
export function pathExit(path: P2[], outline: P2[]): P2 | null {
  for (let k = 1; k < path.length; k++) {
    for (let e = 0; e < outline.length; e++) {
      const hit = segmentIntersection(path[k - 1], path[k], outline[e], outline[(e + 1) % outline.length]);
      if (hit) return hit;
    }
  }
  return null;
}

/** Where a ray from the capture point at `yaw` (room frame) meets the room outline, in plan coordinates. */
export function wallPointAtYaw(d: RoomDims, plan: PlanPlacement, yaw: number): P2 {
  const outline = roomOutlineLocal(d);
  const far: P2 = [Math.sin(yaw) * 100, -Math.cos(yaw) * 100];
  const hit = pathExit([[0, 0], far], outline) ?? [Math.sin(yaw) * 1.5, -Math.cos(yaw) * 1.5];
  return localToPlan(hit, plan);
}

/** Yaw (radians, in room B's panorama frame) looking from B's capture point towards a plan point. */
export function yawTowards(plan: PlanPlacement, p: P2): number {
  return yawToLocal(planToLocal(p, plan));
}

/**
 * Heading continuity when walking through a door: a viewer looking at yaw `yawA` in room A should arrive
 * in room B facing the same real-world direction.
 */
export function arrivalYaw(yawA: number, planA: PlanPlacement, planB: PlanPlacement): number {
  const y = yawA + (planA.rotDeg - planB.rotDeg) * D2R;
  return Math.atan2(Math.sin(y), Math.cos(y));
}

/** Simple left-to-right layout for rooms that have not been placed yet (manual editing starts from here). */
export function autoLayout(rooms: { id: string; dims: RoomDims; plan: PlanPlacement | null }[]): Map<string, PlanPlacement> {
  const out = new Map<string, PlanPlacement>();
  const placed = rooms.filter((r) => r.plan);
  let maxX = -Infinity, minZ = Infinity;
  for (const r of placed) {
    for (const [x, z] of roomOutlinePlan(r.dims, r.plan!)) {
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
    }
  }
  let cursor = Number.isFinite(maxX) ? maxX + 0.5 : 0;
  const top = Number.isFinite(minZ) ? minZ : 0;
  for (const r of rooms.filter((x) => !x.plan)) {
    const local = roomOutlineLocal(r.dims);
    const minLx = Math.min(...local.map((p) => p[0])), maxLx = Math.max(...local.map((p) => p[0]));
    const minLz = Math.min(...local.map((p) => p[1]));
    const p: PlanPlacement = { x: cursor - minLx, z: top - minLz, rotDeg: 0, source: "manual" };
    out.set(r.id, p);
    cursor += maxLx - minLx + 0.3;
  }
  return out;
}

export function planBounds(polys: P2[][]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const poly of polys)
    for (const [x, z] of poly) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  return { minX, maxX, minZ, maxZ };
}
