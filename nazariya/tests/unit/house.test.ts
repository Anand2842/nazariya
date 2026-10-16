import { describe, expect, it } from "vitest";
import { arrivalYaw, autoLayout, localToPlan, pathExit, planToLocal, pointInPolygon, polygonArea, roomOutlinePlan, wallPointAtYaw, yawTowards, type PlanPlacement } from "@/lib/floorplan";
import { rayRoomHit, type RoomDims, type Vec3 } from "@/lib/pano-geometry";
import { depthPanorama, measureRoom, sampleDepth } from "@/lib/room-measure";

const D = 180 / Math.PI;

/** Synthetic depth capture: rays from the phone hit a real room (box), a bed, and a doorway. */
export function syntheticRoomPoints(room: RoomDims, opts: { n?: number; noise?: number; seed?: number } = {}) {
  let seed = opts.seed ?? 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const pts: number[] = [];
  const n = opts.n ?? 40000;
  for (let i = 0; i < n; i++) {
    const z = rnd() * 2 - 1, a = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
    const d: Vec3 = [r * Math.cos(a), z, r * Math.sin(a)];
    let { t } = rayRoomHit(d, room);
    // Bed: top surface 0.5 m above the floor, 1.6 × 2 m, near the camera's left.
    const bedY = -room.camH + 0.5;
    if (d[1] < 0) {
      const tb = bedY / d[1];
      const bx = d[0] * tb, bz = d[2] * tb;
      if (tb < t && bx > -1.6 && bx < -0.3 && bz > -1 && bz < 1) t = tb;
    }
    // Doorway in the wall to the right of the camera (yaw 80–100°, below 2 m): points seen beyond the wall.
    const yaw = Math.atan2(d[0], -d[2]);
    if (yaw > 80 / D && yaw < 100 / D && d[1] * t < 2 - room.camH && d[1] * t > -room.camH) t += 2;
    const nt = t + gauss() * (opts.noise ?? 0.015) * t / 2;
    pts.push(d[0] * nt, d[1] * nt, d[2] * nt);
  }
  return Float32Array.from(pts);
}

describe("room measurement from phone depth", () => {
  const truth: RoomDims = { w: 3.6, d: 4.2, h: 2.8, camH: 1.4, cx: 0.5, cz: -0.3, rotDeg: 20 };

  it("measures an off-centre, rotated room within a few centimetres despite a bed, a doorway and sensor noise", () => {
    const m = measureRoom(syntheticRoomPoints(truth))!;
    expect(m).not.toBeNull();
    // A rectangle has two equivalent descriptions (rotated by 90° with w and d swapped).
    const swapped = Math.abs(((m.dims.rotDeg! - truth.rotDeg! + 360) % 180) - 90) < 10;
    const [w, d] = swapped ? [m.dims.d, m.dims.w] : [m.dims.w, m.dims.d];
    expect(Math.abs(w - truth.w)).toBeLessThan(0.06);
    expect(Math.abs(d - truth.d)).toBeLessThan(0.06);
    expect(Math.abs(m.dims.h - truth.h)).toBeLessThan(0.05);
    expect(Math.abs(m.dims.camH - truth.camH)).toBeLessThan(0.04);
    expect(Math.abs(m.dims.cx! - truth.cx!)).toBeLessThan(0.05);
    expect(Math.abs(m.dims.cz! - truth.cz!)).toBeLessThan(0.05);
    const rotErr = Math.abs(((m.dims.rotDeg! - truth.rotDeg! + 45) % 90) - 45);
    expect(rotErr).toBeLessThan(1);
    expect(m.dims.measured).toBe(true);
    expect(m.fit).toBeGreaterThan(0.6);
    // The measured box reproduces the true wall distances.
    for (const yaw of [0, 1, 2, 3, 4, 5]) {
      const dir: Vec3 = [Math.sin(yaw), 0, -Math.cos(yaw)];
      if (yaw * D > 80 && yaw * D < 100) continue;
      expect(Math.abs(rayRoomHit(dir, m.dims).t - rayRoomHit(dir, truth).t)).toBeLessThan(0.08);
    }
  });

  it("refuses to guess from too few or nonsense points", () => {
    expect(measureRoom(new Float32Array(30))).toBeNull();
    expect(measureRoom(syntheticRoomPoints(truth, { n: 120 }))).toBeNull();
  });

  it("builds a depth panorama that matches the real distances", () => {
    const pts = syntheticRoomPoints(truth, { n: 60000, noise: 0 });
    const dp = depthPanorama(pts, 128);
    const dir: Vec3 = [0, -0.2, -1];
    const n = Math.hypot(...dir);
    const u: Vec3 = [dir[0] / n, dir[1] / n, dir[2] / n];
    expect(Math.abs(sampleDepth(dp, 128, u) - rayRoomHit(u, truth).t)).toBeLessThan(0.1);
  });
});

describe("floor plan geometry", () => {
  const dims: RoomDims = { w: 4, d: 3, h: 2.8, camH: 1.4 };
  const A: PlanPlacement = { x: 0, z: 0, rotDeg: 0, source: "manual" };
  const B: PlanPlacement = { x: 4, z: 0.5, rotDeg: 90, source: "manual" };

  it("converts between room and plan coordinates", () => {
    const p = localToPlan([1, -2], B);
    expect(planToLocal(p, B)[0]).toBeCloseTo(1);
    expect(planToLocal(p, B)[1]).toBeCloseTo(-2);
    // Room B's yaw 0 points along plan +x (rotated 90°): local "ahead" (0, −1) is plan (+1, 0).
    const ahead = localToPlan([0, -1], B);
    expect(ahead[0]).toBeCloseTo(5);
    expect(ahead[1]).toBeCloseTo(0.5);
    expect(polygonArea(roomOutlinePlan(dims, B))).toBeCloseTo(12);
  });

  it("finds where a walked path leaves a room (the doorway)", () => {
    const outline = roomOutlinePlan(dims, A);
    const door = pathExit([[0, 0], [1, 0.2], [2.5, 0.3], [3.5, 0.4]], outline)!;
    expect(door[0]).toBeCloseTo(2);
    expect(door[1]).toBeGreaterThan(0.2);
    expect(door[1]).toBeLessThan(0.3);
    expect(pathExit([[0, 0], [0.5, 0.5]], outline)).toBeNull();
    expect(pointInPolygon([0.1, 0.1], outline)).toBe(true);
    expect(pointInPolygon([3, 0], outline)).toBe(false);
  });

  it("points a door in both rooms at the same doorway and keeps the viewer's real-world heading", () => {
    // Door in A straight to the right (yaw 90°) on the wall at x = 2.
    const p = wallPointAtYaw(dims, A, Math.PI / 2);
    expect(p[0]).toBeCloseTo(2);
    expect(p[1]).toBeCloseTo(0);
    // From B (at x = 4, facing plan +x), the doorway is behind it: yaw ≈ 180°.
    expect(Math.abs(Math.abs(yawTowards(B, p) * D) - 180)).toBeLessThan(15);
    // Walking through facing plan +x (yaw 90° in A) arrives facing B's yaw 0.
    expect(arrivalYaw(Math.PI / 2, A, B)).toBeCloseTo(0);
  });

  it("lays out unplaced rooms side by side without overlapping placed ones", () => {
    const layout = autoLayout([
      { id: "a", dims, plan: A },
      { id: "b", dims, plan: null },
      { id: "c", dims: { ...dims, w: 3 }, plan: null },
    ]);
    const b = roomOutlinePlan(dims, layout.get("b")!), c = roomOutlinePlan({ ...dims, w: 3 }, layout.get("c")!);
    expect(Math.min(...b.map((q) => q[0]))).toBeGreaterThanOrEqual(2);
    expect(Math.min(...c.map((q) => q[0]))).toBeGreaterThanOrEqual(Math.max(...b.map((q) => q[0])));
    expect(layout.has("a")).toBe(false);
  });
});
