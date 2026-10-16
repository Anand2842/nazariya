// Uploads. Files land in private raw storage; the worker derives public, optimised variants.
import { and, eq } from "drizzle-orm";
import { extname } from "node:path";
import type { SessionUser } from "./auth";
import { db } from "./db";
import { DomainError } from "./errors";
import { enqueue } from "./jobs";
import { mediaAssets, zones } from "./schema";
import { loadSpace, workspaceOf } from "./studio";
import { contentKey, putBuffer, sha256 } from "./storage";

export type UploadKind = "photo" | "pano" | "video" | "splat" | "logo";

const LIMITS: Record<UploadKind, { mimes: string[]; maxBytes: number }> = {
  photo: { mimes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 25 * 1024 * 1024 },
  pano: { mimes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 60 * 1024 * 1024 },
  video: { mimes: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: 800 * 1024 * 1024 },
  splat: { mimes: ["model/ply", "model/spz", "model/splat"], maxBytes: 500 * 1024 * 1024 },
  logo: { mimes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 2 * 1024 * 1024 },
};

/** Magic-byte sniffing so a renamed file cannot masquerade as another type. */
export function sniffMime(buf: Uint8Array, name = ""): string | null {
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return brand.startsWith("qt") ? "video/quicktime" : "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b[0] === 0x70 && b[1] === 0x6c && b[2] === 0x79 && (b[3] === 0x0a || b[3] === 0x0d)) return "model/ply";
  if (b[0] === 0x1f && b[1] === 0x8b && /\.spz$/i.test(name)) return "model/spz"; // gzip container
  if (/\.(splat|ksplat)$/i.test(name) && b.byteLength % 32 === 0) return "model/splat";
  return null;
}

export async function handleUpload(
  user: SessionUser,
  file: { name: string; bytes: Uint8Array },
  meta: { spaceId?: string | null; kind: UploadKind; zoneId?: string | null; capture?: { source: string; device?: string; shot?: string } | null },
) {
  const rule = LIMITS[meta.kind];
  if (!rule) throw new DomainError("Unsupported upload type");
  let orgId: string;
  if (meta.kind === "logo") {
    const org = workspaceOf(user);
    if (org.role !== "owner") throw new DomainError("Only the workspace owner can change the logo", "forbidden");
    orgId = org.id;
  } else {
    if (!meta.spaceId) throw new DomainError("Missing space");
    const s = await loadSpace(user, meta.spaceId);
    orgId = s.orgId;
  }
  if (file.bytes.byteLength === 0) throw new DomainError("The file is empty");
  if (file.bytes.byteLength > rule.maxBytes) throw new DomainError(`File too large (max ${Math.round(rule.maxBytes / 1024 / 1024)} MB)`);
  const mime = sniffMime(file.bytes, file.name);
  if (!mime || !rule.mimes.includes(mime)) throw new DomainError(`"${file.name}" doesn't look like a valid ${meta.kind === "pano" ? "360° image" : meta.kind === "splat" ? "3D scan (.ply, .spz, .splat)" : meta.kind} file`);
  if (meta.zoneId) {
    const [z] = await db.select().from(zones).where(and(eq(zones.id, meta.zoneId), eq(zones.spaceId, meta.spaceId!)));
    if (!z) throw new DomainError("Room does not belong to this space");
  }
  const hash = sha256(file.bytes);
  const ext = (extname(file.name).slice(1) || mime.split("/")[1]).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "bin";
  const key = contentKey("priv", `raw-${meta.kind}`, hash, ext);
  await putBuffer(key, file.bytes);
  return db.transaction(async (tx) => {
    const [asset] = await tx
      .insert(mediaAssets)
      .values({
        orgId,
        spaceId: meta.spaceId ?? null,
        kind: meta.kind,
        storageKey: key,
        originalName: file.name.slice(0, 200),
        mime,
        bytes: file.bytes.byteLength,
        sha256: hash,
        meta: {
          ...(meta.zoneId ? { zoneId: meta.zoneId } : {}),
          ...(meta.capture ? { capture: { source: String(meta.capture.source).slice(0, 40), device: String(meta.capture.device ?? "").slice(0, 300), shot: meta.capture.shot ? String(meta.capture.shot).slice(0, 80) : undefined } } : {}),
        },
      })
      .returning();
    if (meta.zoneId && meta.kind === "splat") await tx.update(zones).set({ splatStatus: "queued", splatNote: null }).where(eq(zones.id, meta.zoneId));
    await enqueue(tx, "media.process", { assetId: asset.id });
    return asset;
  });
}

export async function deleteMedia(user: SessionUser, assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a?.spaceId) throw new DomainError("Not found", "not_found");
  await loadSpace(user, a.spaceId);
  await db.transaction(async (tx) => {
    await tx.update(mediaAssets).set({ status: "rejected", rejectReason: "Removed" }).where(eq(mediaAssets.id, assetId));
    const zs = await tx.select().from(zones).where(eq(zones.spaceId, a.spaceId!));
    for (const z of zs) {
      const patch: Partial<typeof zones.$inferInsert> = {};
      if (z.panoAssetId === assetId) Object.assign(patch, { panoAssetId: null, splatStatus: z.splatSource === "generated_from_pano" ? "none" : z.splatStatus, splatAssetId: z.splatSource === "generated_from_pano" ? null : z.splatAssetId });
      if (z.splatAssetId === assetId) Object.assign(patch, { splatAssetId: null, splatStatus: "none", splatSource: null });
      if (z.photoAssetIds.includes(assetId)) patch.photoAssetIds = z.photoAssetIds.filter((p) => p !== assetId);
      if (Object.keys(patch).length) await tx.update(zones).set(patch).where(eq(zones.id, z.id));
    }
  });
}
