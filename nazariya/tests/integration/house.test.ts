import { randomInt, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { localToPlan, roomOutlinePlan, yawToLocal, type PlanPlacement } from "@/lib/floorplan";
import { panoTargets } from "@/lib/orientation";
import { rayRoomHit, type RoomDims, type Vec3 } from "@/lib/pano-geometry";
import { basisInRoom } from "@/lib/xr-pose";
import { loadSessionUser, type SessionUser } from "@/server/auth";
import { closeDb, db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { autoArrange, setZonePlan, submitArRoomCapture } from "@/server/house";
import { buildSplatFromPano } from "@/server/pipeline/splat-from-pano";
import { finishWalkthrough, sessionImages, submitWalkFrames, toNerfstudioMatrix } from "@/server/walkthrough";
import { claimJobs, completeJob, failJob } from "@/server/jobs";
import { loadRaw, renderPerspectiveBasis, type RawImage } from "@/server/pipeline/image";
import { handleJob } from "@/server/pipeline/process";
import { hotspots, jobs, mediaAssets, users, zones } from "@/server/schema";
import * as S from "@/server/studio";

afterAll(async () => closeDb());

async function owner(): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ phone: `+919${String(randomInt(0, 1e9)).padStart(9, "0")}`, name: "House" }).returning();
  await S.createWorkspace((await loadSessionUser(u.id))!, { name: `House Co ${randomInt(0, 1e6)}`, yourName: "House" });
  return (await loadSessionUser(u.id))!;
}

async function drain() {
  for (let i = 0; i < 200; i++) {
    const js = await claimJobs("house-test", 3);
    if (!js.length) {
      const [{ q }] = await db.select({ q: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.status, "queued"), sql`${jobs.runAfter} <= now()`));
      if (!q) return;
      continue;
    }
    for (const j of js) {
      try {
        await completeJob(j.id, await handleJob(j));
      } catch (e) {
        await failJob(j, e);
      }
    }
  }
}

const D2R = Math.PI / 180;
const FOV = 64, IW = 450, IH = 800;
const fy = IH / 2 / Math.tan((FOV / 2) * D2R);

/** A synthetic flat in AR world coordinates (y up, camera height 0, floor at −1.4 m). */
const ROOM_A = { centre: [0, 0] as [number, number], w: 3.6, d: 4.2 };
const ROOM_B = { centre: [3.5, 0] as [number, number], w: 3.2, d: 3.2 };
const H = 2.8, CAM_H = 1.4;
const DOOR = { x: 1.8, z0: -0.45, z1: 0.45, top: 2.1 - CAM_H };

/** Ray-cast the flat from a world position: the room box it is in, plus the doorway into the other room. */
function castWorld(o: Vec3, d: Vec3, room: typeof ROOM_A, other: typeof ROOM_A): number {
  const dims = (r: typeof ROOM_A): RoomDims => ({ w: r.w, d: r.d, h: H, camH: CAM_H, cx: r.centre[0] - o[0], cz: r.centre[1] - o[2] });
  const t = rayRoomHit(d, dims(room)).t;
  const hit: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  // Through the doorway: continue into the other room.
  if (Math.abs(hit[0] - DOOR.x) < 0.11 && hit[2] > DOOR.z0 && hit[2] < DOOR.z1 && hit[1] < DOOR.top) return t + rayRoomHit(d, dims(other)).t - t + 0; // other box from the same origin
  return t;
}

function matrixFor(basis: { right: Vec3; up: Vec3; forward: Vec3 }, p: Vec3): number[] {
  const b = basis;
  return [b.right[0], b.right[1], b.right[2], 0, b.up[0], b.up[1], b.up[2], 0, -b.forward[0], -b.forward[1], -b.forward[2], 0, p[0], p[1], p[2], 1];
}

function cameraBasis(yaw: number, pitch: number): { right: Vec3; up: Vec3; forward: Vec3 } {
  const f: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const r: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { right: r, up: u, forward: f };
}

let seed = 5;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;

async function arCapture(pano: RawImage, origin: Vec3, heading0: number, room: typeof ROOM_A, other: typeof ROOM_A) {
  const frames = [];
  const metaFrames = [];
  for (const t of panoTargets()) {
    const yaw = heading0 + t.yaw, pitch = t.pitch;
    const b = cameraBasis(yaw, pitch);
    const pos: Vec3 = [origin[0] + rnd() * 0.04, origin[1] + rnd() * 0.04, origin[2] + rnd() * 0.04];
    // The picture content only needs to be consistent with the poses (any panorama will do).
    const img = renderPerspectiveBasis(pano, basisInRoom(b, heading0), FOV, IW, IH);
    frames.push({ name: `f${t.id}.jpg`, bytes: new Uint8Array(await sharp(img.data, { raw: { width: IW, height: IH, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()) });
    metaFrames.push({ m: matrixFor(b, pos), target: t.id });
  }
  // Depth points, as the phone collects them while turning (world coordinates).
  const pts: number[] = [];
  for (let i = 0; i < 30000; i++) {
    const z = rnd() * 2, a = (rnd() + 0.5) * 2 * Math.PI, r = Math.sqrt(Math.max(0, 1 - z * z));
    const d: Vec3 = [r * Math.cos(a), z, r * Math.sin(a)];
    const t = castWorld(origin, d, room, other) * (1 + rnd() * 0.01);
    pts.push(origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t);
  }
  const f32 = Float32Array.from(pts);
  return { frames, metaFrames, points: new Uint8Array(f32.buffer) };
}

const intrinsics = { fx: fy, fy, cx: IW / 2, cy: IH / 2, width: IW, height: IH };

describe("house tour: depth-mode capture → measured rooms on a floor plan with doors", () => {
  it("measures two rooms, places them where they really are and connects them at the real doorway", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "2-room flat" });
    const a = await S.createZone(o, s.id, { label: "Living" });
    const b = await S.createZone(o, s.id, { label: "Bedroom" });
    const pano = await loadRaw(await readFile("assets/source/cayley_interior.jpg"), 2048);
    const sessionId = randomUUID();
    const originA: Vec3 = [0.4, 0, -0.3], originB: Vec3 = [3.3, 0, 0.2];
    const heading0 = 37 * D2R;

    const capA = await arCapture(pano, originA, heading0, ROOM_A, ROOM_B);
    await submitArRoomCapture(o, { spaceId: s.id, zoneId: a.id, frames: capA.frames, points: capA.points, meta: { sessionId, device: "test", intrinsics, frames: capA.metaFrames, depth: true } });
    await drain();
    // Walk from A through the doorway into B.
    const path: [number, number, number][] = [];
    for (let k = 0; k <= 30; k++) {
      const t = k / 30;
      const p = t < 0.5 ? [originA[0] + (DOOR.x - originA[0]) * t * 2, 0, originA[2] + (0 - originA[2]) * t * 2] : [DOOR.x + (originB[0] - DOOR.x) * (t - 0.5) * 2, 0, originB[2] * (t - 0.5) * 2];
      path.push(p as [number, number, number]);
    }
    const capB = await arCapture(pano, originB, heading0 + 90 * D2R, ROOM_B, ROOM_A);
    await submitArRoomCapture(o, { spaceId: s.id, zoneId: b.id, frames: capB.frames, points: capB.points, meta: { sessionId, device: "test", intrinsics, frames: capB.metaFrames, path, depth: true } });
    await drain();

    const [za] = await db.select().from(zones).where(eq(zones.id, a.id));
    const [zb] = await db.select().from(zones).where(eq(zones.id, b.id));
    const dA = za.roomDims as RoomDims, dB = zb.roomDims as RoomDims;
    const pA = za.plan as PlanPlacement, pB = zb.plan as PlanPlacement;
    expect(dA.measured).toBe(true);
    expect(dB.measured).toBe(true);
    const sides = (d: RoomDims) => [d.w, d.d].sort((x, y) => x - y);
    expect(Math.abs(sides(dA)[0] - 3.6)).toBeLessThan(0.08);
    expect(Math.abs(sides(dA)[1] - 4.2)).toBeLessThan(0.08);
    expect(Math.abs(sides(dB)[0] - 3.2)).toBeLessThan(0.08);
    expect(Math.abs(dA.h - H)).toBeLessThan(0.06);
    // Placement: same distance apart as in reality; walls square to the plan.
    expect(Math.abs(Math.hypot(pB.x - pA.x, pB.z - pA.z) - Math.hypot(originB[0] - originA[0], originB[2] - originA[2]))).toBeLessThan(0.06);
    for (const [p, d] of [[pA, dA], [pB, dB]] as const) {
      const wallAngle = (((p.rotDeg + (d.rotDeg ?? 0)) % 90) + 90) % 90;
      expect(Math.min(wallAngle, 90 - wallAngle)).toBeLessThan(1.5);
    }
    // Rooms do not overlap on the plan (B is beside A).
    const sep = (k: 0 | 1) => {
      const av = roomOutlinePlan(dA, pA).map((q) => q[k]), bv = roomOutlinePlan(dB, pB).map((q) => q[k]);
      return Math.max(Math.min(...bv) - Math.max(...av), Math.min(...av) - Math.max(...bv));
    };
    expect(Math.max(sep(0), sep(1))).toBeGreaterThan(-0.15);

    // Doors both ways, pointing at the real doorway.
    const hs = await db.select().from(hotspots).where(eq(hotspots.type, "door_to_zone"));
    const ab = hs.find((h) => h.zoneId === a.id && h.targetZoneId === b.id)!;
    const ba = hs.find((h) => h.zoneId === b.id && h.targetZoneId === a.id)!;
    expect(ab).toBeTruthy();
    expect(ba).toBeTruthy();
    // Doorway in plan coordinates, via room A's placement of the true world doorway relative to A's capture point.
    const doorLocalA = (() => {
      const dx = DOOR.x - originA[0], dz = 0 - originA[2];
      const yawWorld = Math.atan2(dx, -dz);
      return yawWorld - heading0;
    })();
    const angDiff = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y))) / D2R;
    expect(angDiff(ab.yaw, doorLocalA)).toBeLessThan(6);
    const doorLocalB = Math.atan2(DOOR.x - originB[0], originB[2] - 0) - (heading0 + 90 * D2R);
    expect(angDiff(ba.yaw, doorLocalB)).toBeLessThan(8);
    // Both door markers are at the same spot on the plan.
    const doorPlanA = localToPlan([Math.sin(ab.yaw), -Math.cos(ab.yaw)], pA);
    expect(Number.isFinite(doorPlanA[0])).toBe(true);
    expect(yawToLocal([0, -1])).toBe(0);

    // 3D built from measured depth.
    const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.spaceId, s.id), eq(mediaAssets.kind, "splat")));
    expect(assets.length).toBe(2);
    for (const x of assets) {
      expect((x.meta as { pipeline: string }).pipeline).toBe("pano_depth_v1");
      expect((x.meta as { scale: string }).scale).toBe("metric");
    }
    const tour = await S.getTourZones(s.id);
    expect(tour.every((z) => z.plan && z.splat?.url && z.pano?.url)).toBe(true);
  }, 240_000);

  it("manual floor plan: auto-arrange, move a room, and doors added in the studio get a way back", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "Manual plan" });
    const a = await S.createZone(o, s.id, { label: "Hall" });
    const b = await S.createZone(o, s.id, { label: "Kitchen" });
    expect(await autoArrange(o, s.id)).toBe(2);
    expect(await autoArrange(o, s.id)).toBe(0);
    await setZonePlan(o, a.id, { x: 0, z: 0, rotDeg: 0 });
    await setZonePlan(o, b.id, { x: 4.3, z: 0, rotDeg: 450 });
    const [zb] = await db.select().from(zones).where(eq(zones.id, b.id));
    expect(zb.plan).toMatchObject({ x: 4.3, z: 0, rotDeg: 90, source: "manual" });
    // A door from Hall to Kitchen, pointing right (yaw 90°): the Kitchen gets a door back automatically.
    await S.addHotspot(o, a.id, { type: "door_to_zone", yaw: Math.PI / 2, pitch: -0.1, title: "Kitchen", targetZoneId: b.id });
    const back = await db.select().from(hotspots).where(and(eq(hotspots.zoneId, b.id), eq(hotspots.targetZoneId, a.id)));
    expect(back).toHaveLength(1);
    // Kitchen faces +x (rotDeg 90) and the Hall is behind it: the way back is about yaw ±180°.
    expect(Math.abs(Math.abs(back[0].yaw) - Math.PI)).toBeLessThan(0.35);
    // Adding the door again does not duplicate the way back.
    await S.addHotspot(o, a.id, { type: "door_to_zone", yaw: Math.PI / 2, pitch: -0.1, title: "Kitchen", targetZoneId: b.id });
    expect(await db.select().from(hotspots).where(and(eq(hotspots.zoneId, b.id), eq(hotspots.targetZoneId, a.id)))).toHaveLength(1);
    await setZonePlan(o, b.id, null);
    const [cleared] = await db.select().from(zones).where(eq(zones.id, b.id));
    expect(cleared.plan).toBeNull();
    const other = await owner();
    await expect(setZonePlan(other, a.id, { x: 0, z: 0, rotDeg: 0 })).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects malformed AR uploads", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "Bad AR" });
    const a = await S.createZone(o, s.id, { label: "Room" });
    const jpg = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#888" } }).jpeg().toBuffer());
    const m = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0));
    const meta = (n: number) => ({ sessionId: randomUUID(), intrinsics, frames: Array.from({ length: n }, () => ({ m })) });
    await expect(submitArRoomCapture(o, { spaceId: s.id, zoneId: a.id, frames: Array(3).fill({ name: "f.jpg", bytes: jpg }), points: null, meta: meta(3) })).rejects.toThrow();
    await expect(submitArRoomCapture(o, { spaceId: s.id, zoneId: a.id, frames: Array(10).fill({ name: "f.jpg", bytes: jpg }), points: new Uint8Array(13), meta: meta(10) })).rejects.toThrow(/Depth data/);
    const other = await S.createSpace(o, { name: "Other" });
    await expect(submitArRoomCapture(o, { spaceId: other.id, zoneId: a.id, frames: Array(10).fill({ name: "f.jpg", bytes: jpg }), points: null, meta: meta(10) })).rejects.toThrow(/room in this space/);
  });
});

describe("true-3D walkthrough dataset (path 2)", () => {
  it("records posed keyframes, writes a nerfstudio dataset and hands it to the GPU worker", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "Walk flat" });
    const sessionId = randomUUID();
    const pano = await loadRaw(await readFile("assets/source/cayley_interior.jpg"), 1024);
    // Walk 3 m forward, turning slowly: 24 keyframes in 3 batches.
    for (let batch = 0; batch < 3; batch++) {
      const frames = [], meta = [];
      for (let i = 0; i < 8; i++) {
        const k = batch * 8 + i;
        const b = cameraBasis(k * 0.08, -0.05);
        // Real keyframes are 960 px on the long side.
        const img = renderPerspectiveBasis(pano, b, FOV, 540, 960);
        frames.push({ bytes: new Uint8Array(await sharp(img.data, { raw: { width: 540, height: 960, channels: 3 } }).jpeg().toBuffer()) });
        meta.push({ m: matrixFor(b, [0.1 * k, 0, -0.12 * k]) });
      }
      await submitWalkFrames(o, { spaceId: s.id, meta: { sessionId, intrinsics: { ...intrinsics, width: 540, height: 960, fx: fy * 1.2, fy: fy * 1.2, cx: 270, cy: 480 }, frames: meta }, frames });
    }
    const imgs = await sessionImages(sessionId);
    expect(imgs).toHaveLength(24);
    // The exported pose is the same camera: column-major WebXR → row-major nerfstudio, translation in the last column.
    const m = imgs[5].m;
    const ns = toNerfstudioMatrix(m);
    expect(ns[0][3]).toBeCloseTo(0.5);
    expect(ns[2][3]).toBeCloseTo(-0.6);
    expect(ns[3]).toEqual([0, 0, 0, 1]);
    expect(ns[0][2]).toBeCloseTo(m[8]);

    // A fake GPU worker that checks the dataset and returns a scene.
    const dir = await mkdtemp(path.join(tmpdir(), "nz-fake-gpu-"));
    const spz = await buildSplatFromPano(await loadRaw(await readFile("assets/source/cayley_interior.jpg"), 512), { w: 4, d: 4, h: 2.8, camH: 1.4 }, 256);
    await writeFile(path.join(dir, "scene.spz"), spz.bytes);
    const script = path.join(dir, "recon.sh");
    await writeFile(script, `#!/bin/sh\nset -e\ntest -f "$1/transforms.json"\ntest "$(ls "$1/images" | wc -l | tr -d ' ')" = "24"\ngrep -q '"fl_x"' "$1/transforms.json"\ncp "${path.join(dir, "scene.spz")}" "$2/scene.spz"\n`);
    await chmod(script, 0o755);
    process.env.NAZARIYA_RECON_CMD = script;
    try {
      await finishWalkthrough(o, { spaceId: s.id, sessionId });
      await drain();
    } finally {
      delete process.env.NAZARIYA_RECON_CMD;
    }
    const tour = await S.getTourZones(s.id);
    const walk = tour.find((z) => z.roomType === "walkthrough")!;
    expect(walk.label).toBe("3D walkthrough");
    expect(walk.splatStatus).toBe("ready");
    expect(walk.splatSource).toBe("reconstructed");
    // The sharpest keyframe of each quarter of the walk (plain-wall views are rejected as too blurry).
    expect(walk.photos.length).toBeGreaterThanOrEqual(3);

    // Without a GPU worker: dataset kept, room shows photos and explains what is missing.
    const s2 = await S.createSpace(o, { name: "Walk flat 2" });
    const sid2 = randomUUID();
    const one = { bytes: new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#777" } }).jpeg().toBuffer()) };
    for (let b = 0; b < 3; b++) await submitWalkFrames(o, { spaceId: s2.id, meta: { sessionId: sid2, intrinsics, frames: Array(8).fill({ m: matrixFor(cameraBasis(b, 0), [b, 0, 0]) }) }, frames: Array(8).fill(one) });
    await finishWalkthrough(o, { spaceId: s2.id, sessionId: sid2 });
    await drain();
    const [w2] = (await S.getTourZones(s2.id)).filter((z) => z.roomType === "walkthrough");
    expect(w2.splatStatus).toBe("needs_gpu_worker");
    expect(w2.splatNote).toMatch(/24 photos with known positions/);
    // Sessions are tied to one space.
    await expect(submitWalkFrames(o, { spaceId: s.id, meta: { sessionId: sid2, intrinsics, frames: [{ m: matrixFor(cameraBasis(0, 0), [0, 0, 0]) }] }, frames: [one] })).rejects.toThrow(/another space/);
  }, 180_000);
});
