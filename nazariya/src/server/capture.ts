// In-app capture: capture links (shoot on a phone without logging in there) and guided-360° frame sets.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "./audit";
import { loadSessionUser, type SessionUser } from "./auth";
import { db } from "./db";
import { DomainError, shortId } from "./errors";
import { enqueue } from "./jobs";
import { sniffMime } from "./media";
import { captureLinks, mediaAssets, spaces, zones } from "./schema";
import { loadSpace } from "./studio";
import { putBuffer, sha256 } from "./storage";

const LINK_TTL_MS = 2 * 3600_000;

function hashToken(t: string) {
  return createHash("sha256").update(`capture:${t}`).digest("hex");
}

export async function createCaptureLink(user: SessionUser, spaceId: string, zoneId: string | null) {
  await loadSpace(user, spaceId);
  if (zoneId) {
    const [z] = await db.select().from(zones).where(and(eq(zones.id, zoneId), eq(zones.spaceId, spaceId)));
    if (!z) throw new DomainError("Room not in this space");
  }
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await db.transaction(async (tx) => {
    await tx.insert(captureLinks).values({ tokenHash: hashToken(token), userId: user.id, spaceId, zoneId, expiresAt });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "capture_link.created", subjectType: "space", subjectId: spaceId });
  });
  return { token, expiresAt };
}

export interface CaptureContext {
  user: SessionUser;
  spaceId: string;
  zoneId: string | null;
  linkId: string;
}

export async function resolveCaptureToken(token: string | null | undefined): Promise<CaptureContext | null> {
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [l] = await db
    .select()
    .from(captureLinks)
    .where(and(eq(captureLinks.tokenHash, hashToken(token)), isNull(captureLinks.revokedAt), gt(captureLinks.expiresAt, new Date())));
  if (!l) return null;
  const user = await loadSessionUser(l.userId);
  if (!user) return null;
  return { user, spaceId: l.spaceId, zoneId: l.zoneId, linkId: l.id };
}

export async function touchCaptureLink(linkId: string) {
  await db.update(captureLinks).set({ uses: sql`${captureLinks.uses} + 1` }).where(eq(captureLinks.id, linkId));
}

/** Data for the phone capture page: the space and its rooms. */
export async function captureTarget(ctx: CaptureContext) {
  const [s] = await db.select().from(spaces).where(eq(spaces.id, ctx.spaceId));
  const rooms = await db.select({ id: zones.id, label: zones.label, roomType: zones.roomType }).from(zones).where(eq(zones.spaceId, ctx.spaceId)).orderBy(asc(zones.sort));
  return { space: { id: s.id, name: s.name }, rooms, zoneId: ctx.zoneId };
}

// ---------- guided 360° ----------

export const panoCaptureMetaSchema = z.object({
  device: z.string().max(300).default(""),
  fovHintDeg: z.number().min(30).max(120).optional(),
  // What the phone reported during capture (helps support diagnose a bad capture).
  diag: z.object({ sensorHz: z.number().min(0).max(1000), frameSync: z.enum(["camera", "estimated"]), latencyMs: z.number().min(0).max(2000) }).partial().optional(),
  frames: z
    .array(
      z.object({
        alpha: z.number().min(-360).max(720),
        beta: z.number().min(-180).max(180),
        gamma: z.number().min(-90).max(90),
        screenAngle: z.number().min(0).max(360).default(0),
        t: z.number().optional(),
        target: z.number().int().optional(),
      }),
    )
    .min(12)
    .max(40),
});

export const MIN_PANO_FRAMES = 12;

/** Store a guided-360° frame set and queue stitching. The result becomes a normal 360° image (→ automatic 3D). */
export async function submitPanoCapture(
  user: SessionUser,
  input: { spaceId: string; zoneId: string; meta: unknown; frames: { name: string; bytes: Uint8Array }[] },
) {
  const space = await loadSpace(user, input.spaceId);
  const [z] = await db.select().from(zones).where(and(eq(zones.id, input.zoneId), eq(zones.spaceId, space.id)));
  if (!z) throw new DomainError("Room not in this space");
  const meta = panoCaptureMetaSchema.parse(input.meta);
  if (input.frames.length !== meta.frames.length) throw new DomainError("Each photo needs its orientation data");
  if (input.frames.length < MIN_PANO_FRAMES) throw new DomainError(`At least ${MIN_PANO_FRAMES} photos are needed for a 360° capture`);
  const captureId = shortId(12);
  const stored: { key: string; sha256: string }[] = [];
  let total = 0;
  for (let i = 0; i < input.frames.length; i++) {
    const f = input.frames[i];
    if (f.bytes.byteLength > 8 * 1024 * 1024) throw new DomainError(`Photo ${i + 1} is too large`);
    if (sniffMime(f.bytes) !== "image/jpeg") throw new DomainError(`Photo ${i + 1} is not a JPEG`);
    total += f.bytes.byteLength;
    const h = sha256(f.bytes);
    const key = `priv/capture/${captureId}/frame_${String(i).padStart(2, "0")}.jpg`;
    await putBuffer(key, f.bytes);
    stored.push({ key, sha256: h });
  }
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .insert(mediaAssets)
      .values({
        orgId: space.orgId,
        spaceId: space.id,
        kind: "pano",
        status: "processing",
        storageKey: `priv/raw-pano/capture-${captureId}.jpg`,
        originalName: `In-app 360° capture (${input.frames.length} photos)`,
        mime: "image/jpeg",
        bytes: total,
        meta: {
          zoneId: z.id,
          capture: { id: captureId, source: "in_app_360", device: meta.device, diag: meta.diag ?? null, fovHintDeg: meta.fovHintDeg ?? null, frames: meta.frames.map((fr, i) => ({ ...fr, key: stored[i].key })) },
        },
      })
      .returning();
    await tx.update(zones).set({ splatStatus: "queued", splatNote: `Stitching 360° from ${input.frames.length} photos…` }).where(eq(zones.id, z.id));
    await enqueue(tx, "capture.stitch_pano", { assetId: asset.id });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "editor", action: "capture.pano_submitted", subjectType: "space", subjectId: space.id, data: { frames: input.frames.length, captureId } });
    return asset;
  });
}
