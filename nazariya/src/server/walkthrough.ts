// "True 3D" walkthrough (path 2): while walking the home in depth mode, the phone records keyframes with
// their AR camera poses. Together with the depth-mode room photos they form a nerfstudio dataset
// (images/ + transforms.json). Known poses let a GPU worker skip structure-from-motion and go straight to
// Gaussian-splat training (gsplat, nerfstudio splatfacto or Brush). Without a GPU worker the dataset is kept
// and the walkthrough shows its photos.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "./audit";
import type { SessionUser } from "./auth";
import { db } from "./db";
import { DomainError } from "./errors";
import { enqueue } from "./jobs";
import { sniffMime } from "./media";
import { arSessions, mediaAssets, spaces, zones } from "./schema";
import { blurScore } from "./pipeline/image";
import { contentKey, getBuffer, putBuffer, sha256 } from "./storage";
import { loadSpace } from "./studio";

const intrinsics = z.object({ fx: z.number().positive(), fy: z.number().positive(), cx: z.number(), cy: z.number(), width: z.number().int().positive(), height: z.number().int().positive() });
export const walkFramesSchema = z.object({
  sessionId: z.string().uuid(),
  intrinsics,
  frames: z.array(z.object({ m: z.array(z.number()).length(16) })).min(1).max(16),
});

interface ManifestEntry {
  key: string;
  m: number[];
  k: z.infer<typeof intrinsics>;
}

const MAX_WALK_FRAMES = 600;
const manifestKey = (sessionId: string) => `priv/recon/${sessionId}/manifest.json`;

async function readManifest(sessionId: string): Promise<ManifestEntry[]> {
  try {
    return JSON.parse((await getBuffer(manifestKey(sessionId))).toString("utf8"));
  } catch {
    return [];
  }
}

async function ensureSession(user: SessionUser, spaceId: string, sessionId: string) {
  const space = await loadSpace(user, spaceId);
  const [s] = await db.select().from(arSessions).where(eq(arSessions.id, sessionId));
  if (s && s.spaceId !== space.id) throw new DomainError("This AR session belongs to another space");
  if (!s) await db.insert(arSessions).values({ id: sessionId, spaceId: space.id, userId: user.id }).onConflictDoNothing();
  return space;
}

/** Append a batch of walkthrough keyframes (JPEG + camera pose) to the session's dataset. */
export async function submitWalkFrames(user: SessionUser, input: { spaceId: string; meta: unknown; frames: { bytes: Uint8Array }[] }) {
  const meta = walkFramesSchema.parse(input.meta);
  await ensureSession(user, input.spaceId, meta.sessionId);
  if (input.frames.length !== meta.frames.length) throw new DomainError("Each photo needs its position data");
  const manifest = await readManifest(meta.sessionId);
  if (manifest.length + input.frames.length > MAX_WALK_FRAMES) throw new DomainError(`A walkthrough can have at most ${MAX_WALK_FRAMES} photos`);
  for (let i = 0; i < input.frames.length; i++) {
    const b = input.frames[i].bytes;
    if (b.byteLength > 4 * 1024 * 1024 || sniffMime(b) !== "image/jpeg") throw new DomainError(`Walkthrough photo ${i + 1} is not a valid JPEG`);
    const key = `priv/recon/${meta.sessionId}/kf_${String(manifest.length).padStart(4, "0")}.jpg`;
    await putBuffer(key, b);
    manifest.push({ key, m: meta.frames[i].m, k: meta.intrinsics });
  }
  await putBuffer(manifestKey(meta.sessionId), new TextEncoder().encode(JSON.stringify(manifest)));
  return { frames: manifest.length };
}

export async function finishWalkthrough(user: SessionUser, input: { spaceId: string; sessionId: string }) {
  const space = await ensureSession(user, input.spaceId, input.sessionId);
  await db.transaction(async (tx) => {
    await enqueue(tx, "recon.walkthrough", { sessionId: input.sessionId });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "capture.walkthrough_submitted", subjectType: "space", subjectId: space.id, data: { sessionId: input.sessionId } });
  });
}

/** Column-major camera-to-world (WebXR) → row-major 4×4 (nerfstudio). Both use the OpenGL camera convention. */
export function toNerfstudioMatrix(m: number[]): number[][] {
  return [0, 1, 2, 3].map((r) => [m[r], m[4 + r], m[8 + r], m[12 + r]]);
}

/** All posed images of a session: walk keyframes plus the depth-mode room photos. */
export async function sessionImages(sessionId: string): Promise<ManifestEntry[]> {
  const rooms = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.kind, "pano"), sql`${mediaAssets.meta}->'capture'->>'sessionId' = ${sessionId}`))
    .orderBy(asc(mediaAssets.createdAt));
  const fromRooms: ManifestEntry[] = rooms.flatMap((a) => {
    const c = (a.meta as { capture: { intrinsics: ManifestEntry["k"]; frames: { m: number[]; key: string }[] } }).capture;
    return c.frames.map((f) => ({ key: f.key, m: f.m, k: c.intrinsics }));
  });
  return [...fromRooms, ...(await readManifest(sessionId))];
}

/** Write images/ + transforms.json (nerfstudio format, per-frame intrinsics) into `dir`. */
export async function writeNerfstudioDataset(dir: string, images: ManifestEntry[]) {
  await mkdir(path.join(dir, "images"), { recursive: true });
  const frames = [];
  for (let i = 0; i < images.length; i++) {
    const name = `images/frame_${String(i).padStart(4, "0")}.jpg`;
    await writeFile(path.join(dir, name), await getBuffer(images[i].key));
    const k = images[i].k;
    frames.push({ file_path: name, transform_matrix: toNerfstudioMatrix(images[i].m), fl_x: k.fx, fl_y: k.fy, cx: k.cx, cy: k.cy, w: k.width, h: k.height });
  }
  const transforms = { camera_model: "OPENCV", frames, nazariya: { units: "metres", up: "+y", source: "webxr-ar" } };
  await writeFile(path.join(dir, "transforms.json"), JSON.stringify(transforms, null, 1));
  return transforms;
}

/** Worker job: build the dataset, create the "3D walkthrough" room, run the GPU worker if configured. */
export async function processWalkthrough(sessionId: string, deps: { runReconstruction: (o: { inputDir: string; zoneId: string; orgId: string; spaceId: string; source: Record<string, unknown> }) => Promise<"done" | "failed">; processPhoto: (id: string) => Promise<unknown> }) {
  const [session] = await db.select().from(arSessions).where(eq(arSessions.id, sessionId));
  if (!session) throw new Error("session missing");
  const images = await sessionImages(sessionId);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, session.spaceId));
  let [zone] = await db.select().from(zones).where(and(eq(zones.spaceId, space.id), eq(zones.roomType, "walkthrough")));
  if (!zone) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(zones).where(eq(zones.spaceId, space.id));
    [zone] = await db.insert(zones).values({ spaceId: space.id, label: "3D walkthrough", roomType: "walkthrough", sort: n }).returning();
  }
  if (images.length < 20) {
    await db.update(zones).set({ splatStatus: "failed", splatNote: `Only ${images.length} walkthrough photos: walk through more of the home with recording on.` }).where(eq(zones.id, zone.id));
    return { images: images.length, status: "too_few" };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "nz-walk-"));
  try {
    const t = await writeNerfstudioDataset(dir, images);
    // Keep the dataset with the space (downloadable for a manual GPU run).
    await putBuffer(`priv/recon/${sessionId}/transforms.json`, new TextEncoder().encode(JSON.stringify(t)));
    // A few keyframes become photos of the walkthrough so it shows something before 3D exists.
    // The sharpest keyframe from each quarter of the walk.
    const walk = images.filter((i) => i.key.includes("/kf_"));
    const picks: ManifestEntry[] = [];
    for (let q = 0; q < 4 && walk.length >= 4; q++) {
      const part = walk.slice(Math.floor((q * walk.length) / 4), Math.floor(((q + 1) * walk.length) / 4));
      let best = part[0], bestScore = -1;
      for (const c of part) {
        const s = await blurScore(await getBuffer(c.key));
        if (s > bestScore) [best, bestScore] = [c, s];
      }
      picks.push(best);
    }
    const photoIds: string[] = [];
    for (const p of picks) {
      const buf = await getBuffer(p.key);
      const key = contentKey("priv", "raw-photo", sha256(buf), "jpg");
      await putBuffer(key, buf);
      const [photo] = await db.insert(mediaAssets).values({ orgId: space.orgId, spaceId: space.id, kind: "photo", storageKey: key, mime: "image/jpeg", bytes: buf.byteLength, sha256: sha256(buf), originalName: "Walkthrough keyframe", meta: { zoneId: zone.id, fromWalkthrough: sessionId } }).returning();
      await deps.processPhoto(photo.id);
      photoIds.push(photo.id);
    }
    if (process.env.NAZARIYA_RECON_CMD) {
      const r = await deps.runReconstruction({ inputDir: dir, zoneId: zone.id, orgId: space.orgId, spaceId: space.id, source: { fromWalkthrough: sessionId } });
      if (r === "done") {
        // The scene is in AR-world metres: start where the walk started, facing the same way.
        const first = walk[0] ?? images[0];
        const m = first.m;
        await db
          .update(zones)
          .set({ splatTransform: { flip: false, yawDeg: 0, scale: 1, offset: [m[12], m[13], m[14]] }, startYaw: Math.atan2(-m[8], m[10]) })
          .where(eq(zones.id, zone.id));
      }
      return { images: images.length, status: r };
    }
    await db
      .update(zones)
      .set({ splatStatus: "needs_gpu_worker", splatNote: `Walkthrough recorded: ${images.length} photos with known positions. True 3D needs the GPU worker (see recon/README.md); photos are shown meanwhile.` })
      .where(eq(zones.id, zone.id));
    return { images: images.length, status: "needs_gpu_worker", photos: photoIds.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
