// Import a reconstructed scene (PLY/SPZ from a GPU or Mac reconstruction run) into a room, the same way the
// worker does after NAZARIYA_RECON_CMD. For runs made by hand, e.g. after cleaning a COLMAP model.
// Usage: node --env-file=.env.local --import tsx scripts/import-scene.ts <zoneId> <scene.ply|scene.spz> [transform.json]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { processSplatImport } from "@/server/pipeline/process";
import { mediaAssets, spaces, zones } from "@/server/schema";
import { contentKey, putBuffer, sha256 } from "@/server/storage";

const [zoneId, file, transformFile] = process.argv.slice(2);
if (!zoneId || !file) throw new Error("usage: import-scene.ts <zoneId> <scene.ply|scene.spz>");
const [zone] = await db.select().from(zones).where(eq(zones.id, zoneId));
if (!zone) throw new Error("room not found");
const [space] = await db.select().from(spaces).where(eq(spaces.id, zone.spaceId));
const buf = await readFile(file);
const ext = path.extname(file).slice(1).toLowerCase();
const key = contentKey("priv", "raw-splat", sha256(buf), ext);
await putBuffer(key, buf);
const [asset] = await db
  .insert(mediaAssets)
  .values({ orgId: space.orgId, spaceId: space.id, kind: "splat", storageKey: key, mime: ext === "ply" ? "model/ply" : "model/spz", bytes: buf.byteLength, sha256: sha256(buf), originalName: path.basename(file), meta: { zoneId, importedBy: "import-scene" } })
  .returning();
console.log(await processSplatImport(asset.id));
const tf = transformFile ? (JSON.parse(await readFile(transformFile, "utf8")) as { align: number[]; scale: number; offset: number[]; startYaw?: number }) : null;
await db
  .update(zones)
  .set({ splatSource: "reconstructed", ...(tf ? { splatTransform: { flip: false, yawDeg: 0, scale: tf.scale, align: tf.align, offset: tf.offset }, ...(tf.startYaw !== undefined ? { startYaw: tf.startYaw } : {}) } : {}) })
  .where(eq(zones.id, zoneId));
process.exit(0);
