// House tours: rooms on a floor plan, doors between them, and depth-sensing (AR) room captures that measure
// the room, place it on the plan and connect it to the previous room automatically.
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import { autoLayout, pathExit, roomOutlinePlan, rotate2, wallPointAtYaw, yawTowards, type P2, type PlanPlacement } from "@/lib/floorplan";
import { positionFromYawPitch, validateRoomDims, type RoomDims, type Vec3 } from "@/lib/pano-geometry";
import { depthPanorama, measureRoom } from "@/lib/room-measure";
import { basisInRoom, fovLongDeg, pointInRoom, poseFromMatrix, yawOfDir } from "@/lib/xr-pose";
import { writeAudit } from "./audit";
import type { SessionUser } from "./auth";
import { db } from "./db";
import { DomainError, shortId } from "./errors";
import { enqueue } from "./jobs";
import { sniffMime } from "./media";
import { arSessions, hotspots, mediaAssets, zones } from "./schema";
import { getBuffer, putBuffer, sha256 } from "./storage";
import { loadSpace, loadZone } from "./studio";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const DOOR_PITCH = -0.12; // door markers sit a little below eye level

type ZoneRow = typeof zones.$inferSelect;
const planOf = (z: ZoneRow) => (z.plan as PlanPlacement | null) ?? null;
const dimsOf = (z: ZoneRow) => z.roomDims as RoomDims;

// ---------- manual floor plan ----------

const planInput = z.object({ x: z.number().min(-500).max(500), z: z.number().min(-500).max(500), rotDeg: z.number().min(-3600).max(3600) });

export async function setZonePlan(user: SessionUser, zoneId: string, input: z.input<typeof planInput> | null) {
  await loadZone(user, zoneId);
  if (input === null) {
    await db.update(zones).set({ plan: null }).where(eq(zones.id, zoneId));
    return null;
  }
  const v = planInput.parse(input);
  const plan: PlanPlacement = { x: Math.round(v.x * 100) / 100, z: Math.round(v.z * 100) / 100, rotDeg: ((Math.round(v.rotDeg * 10) / 10) % 360 + 360) % 360, source: "manual" };
  await db.update(zones).set({ plan }).where(eq(zones.id, zoneId));
  return plan;
}

/** Put every room that is not on the floor plan yet next to the ones that are. */
export async function autoArrange(user: SessionUser, spaceId: string) {
  await loadSpace(user, spaceId);
  const zs = await db.select().from(zones).where(eq(zones.spaceId, spaceId));
  const layout = autoLayout(zs.map((z) => ({ id: z.id, dims: dimsOf(z), plan: planOf(z) })));
  for (const [id, plan] of layout) await db.update(zones).set({ plan }).where(eq(zones.id, id));
  return layout.size;
}

/** Plan-space doorway for a door hotspot (where its direction meets the room's wall). */
export function doorPoint(zone: ZoneRow, yaw: number): P2 | null {
  const plan = planOf(zone);
  return plan ? wallPointAtYaw(dimsOf(zone), plan, yaw) : null;
}

async function doorExists(fromZoneId: string, toZoneId: string) {
  const [h] = await db.select({ id: hotspots.id }).from(hotspots).where(and(eq(hotspots.zoneId, fromZoneId), eq(hotspots.type, "door_to_zone"), eq(hotspots.targetZoneId, toZoneId)));
  return !!h;
}

async function insertDoor(createdBy: string | null, from: ZoneRow, to: ZoneRow, yaw: number) {
  const dims = dimsOf(from);
  await db.insert(hotspots).values({ zoneId: from.id, type: "door_to_zone", yaw, pitch: DOOR_PITCH, targetZoneId: to.id, title: `Go to ${to.label}`.slice(0, 80), position: positionFromYawPitch(yaw, DOOR_PITCH, dims), createdBy });
}

/**
 * After a door A→B is added: if both rooms are on the floor plan and B has no door back to A, add one at the
 * same doorway (as seen from B's capture point).
 */
export async function addReturnDoor(createdBy: string, from: ZoneRow, toZoneId: string, yaw: number) {
  const [to] = await db.select().from(zones).where(eq(zones.id, toZoneId));
  const p = doorPoint(from, yaw);
  const toPlan = to ? planOf(to) : null;
  if (!to || !p || !toPlan || (await doorExists(to.id, from.id))) return null;
  const back = yawTowards(toPlan, p);
  await insertDoor(createdBy, to, from, back);
  return back;
}

// ---------- depth-sensing (AR) room capture ----------

export const arRoomMetaSchema = z.object({
  sessionId: z.string().uuid(),
  device: z.string().max(300).default(""),
  // Pinhole intrinsics of the uploaded frames (pixels).
  intrinsics: z.object({ fx: z.number().positive(), fy: z.number().positive(), cx: z.number(), cy: z.number(), width: z.number().int().positive(), height: z.number().int().positive() }),
  // Camera-to-world matrices (column-major) in the session's AR world frame.
  frames: z.array(z.object({ m: z.array(z.number()).length(16), target: z.number().int().optional() })).min(8).max(40),
  // Camera positions walked since the previous room of this session (AR world), for door placement.
  path: z.array(z.tuple([z.number(), z.number(), z.number()])).max(5000).default([]),
  depth: z.boolean().default(false),
  diag: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});

const MAX_POINTS_BYTES = 8 * 1024 * 1024;

/** Store an AR room capture (frames + poses + depth points) and queue processing. */
export async function submitArRoomCapture(
  user: SessionUser,
  input: { spaceId: string; zoneId: string; meta: unknown; frames: { name: string; bytes: Uint8Array }[]; points: Uint8Array | null },
) {
  const space = await loadSpace(user, input.spaceId);
  const [zone] = await db.select().from(zones).where(and(eq(zones.id, input.zoneId), eq(zones.spaceId, space.id)));
  if (!zone) throw new DomainError("Choose a room in this space");
  const meta = arRoomMetaSchema.parse(input.meta);
  if (input.frames.length !== meta.frames.length) throw new DomainError("Each photo needs its position data");
  if (input.points && (input.points.byteLength % 12 !== 0 || input.points.byteLength > MAX_POINTS_BYTES)) throw new DomainError("Depth data is malformed or too large");
  const captureId = shortId(12);
  const keys: string[] = [];
  for (let i = 0; i < input.frames.length; i++) {
    const f = input.frames[i];
    if (f.bytes.byteLength > 8 * 1024 * 1024) throw new DomainError(`Photo ${i + 1} is too large`);
    if (sniffMime(f.bytes) !== "image/jpeg") throw new DomainError(`Photo ${i + 1} is not a JPEG`);
    const key = `priv/capture/${captureId}/frame_${String(i).padStart(2, "0")}.jpg`;
    await putBuffer(key, f.bytes);
    keys.push(key);
  }
  let pointsKey: string | null = null;
  if (input.points?.byteLength) {
    pointsKey = `priv/capture/${captureId}/points.f32`;
    await putBuffer(pointsKey, input.points);
  }
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(arSessions).where(eq(arSessions.id, meta.sessionId));
    if (existing && existing.spaceId !== space.id) throw new DomainError("This AR session belongs to another space");
    if (!existing) await tx.insert(arSessions).values({ id: meta.sessionId, spaceId: space.id, userId: user.id, device: meta.device.slice(0, 300) });
    const [asset] = await tx
      .insert(mediaAssets)
      .values({
        orgId: space.orgId,
        spaceId: space.id,
        kind: "pano",
        status: "processing",
        storageKey: `priv/raw-pano/ar-${captureId}.jpg`,
        originalName: `Depth-mode 360° capture (${input.frames.length} photos)`,
        mime: "image/jpeg",
        bytes: input.frames.reduce((a, f) => a + f.bytes.byteLength, 0),
        meta: {
          zoneId: zone.id,
          capture: {
            id: captureId,
            source: "in_app_ar",
            sessionId: meta.sessionId,
            device: meta.device,
            intrinsics: meta.intrinsics,
            frames: meta.frames.map((f, i) => ({ ...f, key: keys[i] })),
            pointsKey,
            path: meta.path,
            depth: meta.depth && !!pointsKey,
            diag: meta.diag ?? null,
          },
        },
      })
      .returning();
    await tx.update(zones).set({ splatStatus: "queued", splatNote: meta.depth ? "Measuring the room and stitching 360°…" : "Stitching 360°…" }).where(eq(zones.id, zone.id));
    await enqueue(tx, "capture.ar_room", { assetId: asset.id });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "capture.ar_room_submitted", subjectType: "space", subjectId: space.id, data: { frames: input.frames.length, depth: !!pointsKey, sessionId: meta.sessionId } });
    return asset;
  });
}

interface ArCaptureMeta {
  sessionId: string;
  intrinsics: { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
  frames: { m: number[]; key: string }[];
  pointsKey: string | null;
  path: [number, number, number][];
}

/** The room frame of an AR capture: capture point (mean camera position) and the heading of the first photo. */
export function arRoomFrame(frames: { m: number[] }[]) {
  const poses = frames.map((f) => poseFromMatrix(f.m));
  const origin: Vec3 = [0, 1, 2].map((k) => poses.reduce((a, p) => a + p.position[k], 0) / poses.length) as Vec3;
  const headingRef = yawOfDir(poses[0].basis.forward);
  // How far the phone wandered from the capture point (parallax risk), metres.
  const drift = Math.max(...poses.map((p) => Math.hypot(p.position[0] - origin[0], p.position[2] - origin[2])));
  return { poses, origin, headingRef, drift };
}

export interface WorldToPlan {
  rotDeg: number; // plan heading = world heading + rotDeg
  origin: [number, number]; // world (x, z) that maps to `at`
  at: [number, number];
}

/** AR-world → plan transform for a session's first room: walls axis-aligned, placed next to existing rooms. */
export function initialWorldToPlan(origin: Vec3, wallYawWorldDeg: number, others: { dims: RoomDims; plan: PlanPlacement }[]): WorldToPlan {
  const rotDeg = -(((wallYawWorldDeg % 90) + 90) % 90);
  let at: [number, number] = [0, 0];
  if (others.length) {
    let maxX = -Infinity, minZ = Infinity;
    for (const o of others) for (const [x, zz] of roomOutlinePlan(o.dims, o.plan)) [maxX, minZ] = [Math.max(maxX, x), Math.min(minZ, zz)];
    // Start the new session to the right of what is already drawn (the user can drag it later).
    at = [maxX + 3, minZ + 2];
  }
  return { rotDeg, origin: [origin[0], origin[2]], at };
}

export function worldToPlanPoint(p: [number, number] | Vec3, w: WorldToPlan): P2 {
  const x = p[0], zz = p.length === 3 ? p[2] : p[1];
  const r = rotate2([x - w.origin[0], zz - w.origin[1]], w.rotDeg);
  return [r[0] + w.at[0], r[1] + w.at[1]];
}

/** Worker job: AR capture → stitched 360°, measured room, floor-plan placement, doors, then the usual 3D build. */
export async function processArRoomCapture(assetId: string, deps: { stitch: typeof import("./pipeline/stitch").stitchEquirect; loadRaw: typeof import("./pipeline/image").loadRaw; encodeJpeg: (pano: { data: Buffer | Uint8Array; width: number; height: number }) => Promise<Buffer>; processPano: (id: string) => Promise<unknown>; reject: (id: string, reason: string) => Promise<unknown> }) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new Error("asset missing");
  const cap = (a.meta as { capture: ArCaptureMeta }).capture;
  const zoneId = (a.meta as { zoneId: string }).zoneId;
  const { poses, origin, headingRef, drift } = arRoomFrame(cap.frames);
  const k = cap.intrinsics;
  const frames = [];
  for (let i = 0; i < cap.frames.length; i++) frames.push({ image: await deps.loadRaw(await getBuffer(cap.frames[i].key), 1280), basis: basisInRoom(poses[i].basis, headingRef) });
  const t0 = Date.now();
  // Poses from AR tracking are accurate, so the stitcher only needs a small search.
  const r = deps.stitch(frames, { width: 4096, fovLongDeg: fovLongDeg(k), searchDeg: 2 });
  if (r.coverage < 0.85) {
    await db.update(zones).set({ splatStatus: "failed", splatNote: null }).where(eq(zones.id, zoneId));
    return deps.reject(assetId, `Parts of the room were missed (${Math.round(r.coverage * 100)}% covered). Capture again and follow every dot.`);
  }

  // Measure the room from depth points (room-local coordinates).
  let measured: ReturnType<typeof measureRoom> = null;
  let depthKey: string | null = null;
  if (cap.pointsKey) {
    const buf = await getBuffer(cap.pointsKey);
    const world = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const local = new Float32Array(world.length);
    for (let i = 0; i + 2 < world.length; i += 3) {
      const p = pointInRoom([world[i], world[i + 1], world[i + 2]], origin, headingRef);
      local[i] = p[0];
      local[i + 1] = p[1];
      local[i + 2] = p[2];
    }
    measured = measureRoom(local);
    const dp = depthPanorama(local, 256);
    depthKey = `priv/depth/${assetId}.f32`;
    await putBuffer(depthKey, new Uint8Array(dp.buffer, dp.byteOffset, dp.byteLength));
  }

  const [zone] = await db.select().from(zones).where(eq(zones.id, zoneId));
  const dims = measured ? validateRoomDims(measured.dims) : dimsOf(zone);

  // Floor-plan placement in the session's shared frame.
  const [session] = await db.select().from(arSessions).where(eq(arSessions.id, cap.sessionId));
  let w2p = session?.worldToPlan as WorldToPlan | null;
  if (!w2p) {
    const others = (await db.select().from(zones).where(and(eq(zones.spaceId, zone.spaceId), ne(zones.id, zoneId), isNotNull(zones.plan)))).map((o) => ({ dims: dimsOf(o), plan: planOf(o)! }));
    w2p = initialWorldToPlan(origin, headingRef * R2D + (dims.rotDeg ?? 0), others);
    if (session) await db.update(arSessions).set({ worldToPlan: w2p }).where(eq(arSessions.id, session.id));
  }
  const at = worldToPlanPoint(origin, w2p);
  const plan: PlanPlacement = { x: Math.round(at[0] * 100) / 100, z: Math.round(at[1] * 100) / 100, rotDeg: (((headingRef * R2D + w2p.rotDeg) % 360) + 360) % 360, source: "ar", sessionId: cap.sessionId };
  await db.update(zones).set({ roomDims: dims, plan }).where(eq(zones.id, zoneId));
  // Existing hotspots follow the new shape.
  for (const h of await db.select().from(hotspots).where(eq(hotspots.zoneId, zoneId))) await db.update(hotspots).set({ position: positionFromYawPitch(h.yaw, h.pitch, dims) }).where(eq(hotspots.id, h.id));

  // Door from the previous room of this session: where the walked path left that room.
  let door: { from: string; to: string; at: P2 } | null = null;
  if (session?.lastZoneId && session.lastZoneId !== zoneId) {
    const [prev] = await db.select().from(zones).where(eq(zones.id, session.lastZoneId));
    const prevPlan = prev ? planOf(prev) : null;
    if (prev && prevPlan && prev.spaceId === zone.spaceId) {
      const path: P2[] = [[prevPlan.x, prevPlan.z], ...cap.path.map((p) => worldToPlanPoint(p, w2p!)), [plan.x, plan.z]];
      const exit = pathExit(path, roomOutlinePlan(dimsOf(prev), prevPlan));
      // Without a clean crossing (e.g. a large open-plan space), connect the two capture points directly.
      const p: P2 = exit ?? [(prevPlan.x + plan.x) / 2, (prevPlan.z + plan.z) / 2];
      const thisZone = { ...zone, roomDims: dims, plan };
      if (!(await doorExists(prev.id, zoneId))) await insertDoor(null, prev, thisZone, yawTowards(prevPlan, p));
      if (!(await doorExists(zoneId, prev.id))) await insertDoor(null, thisZone, prev, yawTowards(plan, p));
      door = { from: prev.id, to: zoneId, at: p };
    }
  }
  if (session) await db.update(arSessions).set({ lastZoneId: zoneId }).where(eq(arSessions.id, session.id));

  const jpeg = await deps.encodeJpeg(r.pano);
  await putBuffer(a.storageKey, jpeg);
  const ar = {
    measured: !!measured,
    fit: measured?.fit ?? null,
    dims: measured ? dims : null,
    areaM2: measured ? Math.round(dims.w * dims.d * 10) / 10 : null,
    phoneDriftM: Math.round(drift * 100) / 100,
    door,
    depthKey,
    depthW: depthKey ? 256 : null,
  };
  const stats = { fovLongDeg: Math.round(r.fovLongDeg * 10) / 10, coverage: Math.round(r.coverage * 1000) / 1000, stitchMs: Date.now() - t0, frames: frames.length, pairDisagreementP90Deg: r.pairDisagreementP90Deg, warning: drift > 0.25 ? "The phone moved more than 25 cm during the capture, so some seams may show." : null };
  await db.update(mediaAssets).set({ sha256: sha256(jpeg), bytes: jpeg.byteLength, meta: { ...(a.meta as object), stitch: stats, ar, depth: depthKey ? { key: depthKey, W: 256 } : null } }).where(eq(mediaAssets.id, assetId));
  const res = await deps.processPano(assetId);
  return { ...(res as object), ar };
}
