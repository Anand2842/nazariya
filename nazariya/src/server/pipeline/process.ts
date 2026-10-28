// Job handlers run by scripts/worker.ts.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import type { RoomDims } from "@/lib/pano-geometry";
import { db } from "../db";
import { enqueue, type ClaimedJob } from "../jobs";
import { mediaAssets, notifications, zones } from "../schema";
import { absPath, contentKey, getBuffer, putBuffer, sha256 } from "../storage";
import { blurScore, equirectToPerspective, loadRaw } from "./image";
import { buildSplatFromPano } from "./splat-from-pano";
import { stitchEquirect, type StitchFrame } from "./stitch";
import { processArRoomCapture } from "../house";
import { processWalkthrough } from "../walkthrough";
import { angleBetween, headingOf, tourBasis } from "@/lib/orientation";

const run = promisify(execFile);

export class PermanentJobError extends Error {}

async function putDerived(kind: string, buf: Buffer | Uint8Array, ext: string) {
  const key = contentKey("pub", kind, sha256(buf), ext);
  await putBuffer(key, buf);
  return key;
}

export const BLUR_REJECT_THRESHOLD = 12;

async function reject(assetId: string, reason: string) {
  await db.update(mediaAssets).set({ status: "rejected", rejectReason: reason }).where(eq(mediaAssets.id, assetId));
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  const zoneId = (a?.meta as { zoneId?: string })?.zoneId;
  if (a?.kind === "splat" && zoneId) await db.update(zones).set({ splatStatus: "failed", splatNote: reason }).where(eq(zones.id, zoneId));
  return { rejected: true, reason };
}

async function zoneIdOf(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  return (a?.meta as { zoneId?: string })?.zoneId ?? null;
}

export async function processPhoto(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new PermanentJobError("asset missing");
  await db.update(mediaAssets).set({ status: "processing" }).where(eq(mediaAssets.id, assetId));
  const src = await getBuffer(a.storageKey);
  const meta = await sharp(src).rotate().metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  if (Math.min(w, h) < 480) return reject(assetId, "Image resolution is too low (min 480 px on the short side)");
  const blur = await blurScore(src);
  if (blur < BLUR_REJECT_THRESHOLD) return reject(assetId, "Image is too blurry: hold the camera steady and retake");
  // Re-encoding strips EXIF/GPS metadata from everything that becomes public.
  const full = await sharp(src).rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await sharp(src).rotate().resize({ width: 480, height: 360, fit: "cover" }).webp({ quality: 72 }).toBuffer();
  const variants = { full: await putDerived("photo", full, "webp"), thumb: await putDerived("photo", thumb, "webp") };
  await db.update(mediaAssets).set({ status: "ready", width: w, height: h, blurScore: blur, variants }).where(eq(mediaAssets.id, assetId));
  const zoneId = await zoneIdOf(assetId);
  if (zoneId) await db.update(zones).set({ photoAssetIds: sql`array_append(${zones.photoAssetIds}, ${assetId}::uuid)` }).where(eq(zones.id, zoneId));
  return { variants, blur };
}

export async function processPano(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new PermanentJobError("asset missing");
  await db.update(mediaAssets).set({ status: "processing" }).where(eq(mediaAssets.id, assetId));
  const src = await getBuffer(a.storageKey);
  const meta = await sharp(src).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (Math.abs(w / Math.max(1, h) - 2) > 0.04) return reject(assetId, "Not a 360° image: expected a 2:1 equirectangular panorama (use the 360° mode of your camera/phone app)");
  if (w < 2048) return reject(assetId, "360° image resolution is too low (min 2048×1024)");
  const full = await sharp(src).resize(Math.min(4096, w), Math.min(2048, h)).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const mobile = await sharp(src).resize(2048, 1024).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  const poster = await equirectToPerspective(await loadRaw(mobile), { yaw: 0, width: 1200, height: 675, hfovDeg: 90 });
  const thumb = await sharp(poster).resize(480, 270).webp({ quality: 72 }).toBuffer();
  const variants = {
    full: await putDerived("pano", full, "jpg"),
    mobile: await putDerived("pano", mobile, "jpg"),
    poster: await putDerived("pano", poster, "jpg"),
    thumb: await putDerived("pano", thumb, "webp"),
  };
  await db.update(mediaAssets).set({ status: "ready", width: w, height: h, blurScore: await blurScore(poster), variants }).where(eq(mediaAssets.id, assetId));
  const zoneId = await zoneIdOf(assetId);
  if (zoneId) {
    const [z] = await db.select().from(zones).where(eq(zones.id, zoneId));
    const keepImported = z.splatSource && z.splatSource !== "generated_from_pano" && z.splatStatus === "ready";
    await db
      .update(zones)
      .set(keepImported ? { panoAssetId: assetId } : { panoAssetId: assetId, splatStatus: "queued", splatAssetId: null, splatSource: null, splatNote: null })
      .where(eq(zones.id, zoneId));
    // Every 360° image automatically gets a 3D walkthrough build.
    if (!keepImported) await enqueue(db, "scene.build_from_pano", { zoneId });
  }
  return { variants };
}

export async function processLogo(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new PermanentJobError("asset missing");
  const src = await getBuffer(a.storageKey);
  const full = await sharp(src).resize({ height: 96, width: 400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  await db.update(mediaAssets).set({ status: "ready", variants: { full: await putDerived("logo", full, "png") } }).where(eq(mediaAssets.id, assetId));
  return {};
}

// Quality gates for 3D scenes (mobile budget from the viewer architecture).
export const SPLAT_BUDGET = { desktopMaxBytes: 60 * 1024 * 1024, mobileMaxBytes: 15 * 1024 * 1024, minSplats: 5_000 };

export async function buildSceneFromPano(zoneId: string) {
  const [z] = await db.select().from(zones).where(eq(zones.id, zoneId));
  if (!z) throw new PermanentJobError("zone missing");
  if (!z.panoAssetId) {
    await db.update(zones).set({ splatStatus: "failed", splatNote: "No 360° image" }).where(eq(zones.id, zoneId));
    return { failed: true };
  }
  await db.update(zones).set({ splatStatus: "processing" }).where(eq(zones.id, zoneId));
  const [pano] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, z.panoAssetId));
  if (pano.status !== "ready") {
    await db.update(zones).set({ splatStatus: "queued" }).where(eq(zones.id, zoneId));
    throw new Error("360° image not processed yet; will retry");
  }
  const variants = pano.variants as Record<string, string>;
  const raw = await loadRaw(await getBuffer(variants.full ?? variants.mobile), 3072);
  const room = z.roomDims as RoomDims;
  // Depth-mode captures carry a measured depth panorama: the 3D room gets its real shape (furniture, alcoves).
  const dm = (pano.meta as { depth?: { key: string; W: number } | null }).depth;
  let depth: { data: Float32Array; W: number } | null = null;
  if (dm?.key) {
    const b = await getBuffer(dm.key);
    depth = { data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), W: dm.W };
  }
  const t0 = Date.now();
  // Desktop ≈ 750k splats (~4 MB), mobile ≈ 250k splats (~1.5 MB): within the viewer's budgets.
  const desktop = await buildSplatFromPano(raw, room, 1536, depth);
  const mobile = await buildSplatFromPano(raw, room, 896, depth);
  const metrics = {
    splatsDesktop: desktop.splats,
    splatsMobile: mobile.splats,
    bytesDesktop: desktop.bytes.byteLength,
    bytesMobile: mobile.bytes.byteLength,
    buildMs: Date.now() - t0,
    pipeline: depth ? "pano_depth_v1" : "pano_box_projection_v1",
    scale: room.measured ? "metric" : "arbitrary",
  };
  if (desktop.splats < SPLAT_BUDGET.minSplats || desktop.bytes.byteLength > SPLAT_BUDGET.desktopMaxBytes || mobile.bytes.byteLength > SPLAT_BUDGET.mobileMaxBytes) {
    await db.update(zones).set({ splatStatus: "qa_failed", splatNote: "3D quality check failed; the 360° view is still available" }).where(eq(zones.id, zoneId));
    return { qaFailed: true, metrics };
  }
  const keys = { desktop: await putDerived("splat", desktop.bytes, "spz"), mobile: await putDerived("splat", mobile.bytes, "spz") };
  const [asset] = await db
    .insert(mediaAssets)
    .values({ orgId: pano.orgId, spaceId: pano.spaceId, kind: "splat", status: "ready", storageKey: keys.desktop, mime: "model/spz", bytes: desktop.bytes.byteLength, sha256: sha256(desktop.bytes), variants: keys, meta: metrics })
    .returning();
  await db
    .update(zones)
    .set({ splatStatus: "ready", splatAssetId: asset.id, splatSource: "generated_from_pano", splatNote: null, splatTransform: { flip: false, yawDeg: 0, scale: 1 } })
    .where(eq(zones.id, zoneId));
  return { metrics };
}

/** Imported 3D scans (Polycam / Scaniverse / Luma / KIRI / XGRIDS exports, or our GPU worker output). */
export async function processSplatImport(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new PermanentJobError("asset missing");
  const zoneId = (a.meta as { zoneId?: string }).zoneId ?? null;
  await db.update(mediaAssets).set({ status: "processing" }).where(eq(mediaAssets.id, assetId));
  if (zoneId) await db.update(zones).set({ splatStatus: "processing" }).where(eq(zones.id, zoneId));
  const spark = await import("@sparkjsdev/spark");
  const bytes = new Uint8Array(await getBuffer(a.storageKey));
  const fileType = a.mime === "model/ply" ? spark.SplatFileType.PLY : a.mime === "model/spz" ? spark.SplatFileType.SPZ : spark.SplatFileType.SPLAT;
  let desktop: Uint8Array;
  let mobile: Uint8Array;
  try {
    if (fileType === spark.SplatFileType.SPZ) {
      // Already the compact delivery format (Spark's transcoder does not re-encode SPZ input): validate and keep.
      const probe = new spark.SpzReader({ fileBytes: bytes });
      await probe.parseHeader();
      desktop = mobile = bytes;
    } else {
      // Keep all colour detail (SH degree 3): on a held-out-frame test (Oct 2026) degree 1 lost 3.9 dB PSNR and degree 0
      // lost 4.9 dB, while dropping faint splats (opacity < 0.05) cost nothing and roughly halves the file.
      desktop = (await spark.transcodeSpz({ inputs: [{ fileBytes: bytes, fileType, pathOrUrl: a.originalName ?? undefined }], maxSh: 3, opacityThreshold: 0.02 })).fileBytes;
      mobile = (await spark.transcodeSpz({ inputs: [{ fileBytes: bytes, fileType, pathOrUrl: a.originalName ?? undefined }], maxSh: 3, opacityThreshold: 0.05 })).fileBytes;
    }
  } catch (e) {
    return reject(assetId, `Could not read this 3D scan: ${(e as Error).message.slice(0, 160)}`);
  }
  const reader = new spark.SpzReader({ fileBytes: desktop });
  await reader.parseHeader();
  const splats = reader.numSplats;
  const metrics = { splatsDesktop: splats, bytesDesktop: desktop.byteLength, bytesMobile: mobile.byteLength, source: a.originalName, pipeline: "import_transcode_spz" };
  if (splats < SPLAT_BUDGET.minSplats) return reject(assetId, "This scan contains too few points to display");
  if (mobile.byteLength > SPLAT_BUDGET.mobileMaxBytes) {
    // Too heavy for phones: still usable on desktop, flagged for the editor.
    (metrics as Record<string, unknown>).mobileOverBudget = true;
  }
  const keys = { desktop: await putDerived("splat", desktop, "spz"), mobile: await putDerived("splat", mobile, "spz") };
  await db.update(mediaAssets).set({ status: "ready", variants: keys, meta: { ...(a.meta as object), ...metrics } }).where(eq(mediaAssets.id, assetId));
  if (zoneId) await db.update(zones).set({ splatStatus: "ready", splatAssetId: assetId, splatSource: "imported", splatNote: null }).where(eq(zones.id, zoneId));
  return metrics;
}

/**
 * External reconstruction (structure-from-motion + Gaussian-splat training on a GPU) through the
 * NAZARIYA_RECON_CMD contract: `<cmd> <inputDir> <outDir>`. The input is either plain frames or a
 * nerfstudio dataset (images/ + transforms.json with known camera poses, from depth-mode capture, which lets
 * the worker skip SfM). The command writes <outDir>/scene.ply or scene.spz, imported like an uploaded scan.
 */
export async function runReconstruction(opts: { inputDir: string; zoneId: string; orgId: string; spaceId: string; source: Record<string, unknown> }): Promise<"done" | "failed"> {
  const recon = process.env.NAZARIYA_RECON_CMD!;
  const outDir = await mkdtemp(path.join(tmpdir(), "nz-recon-"));
  try {
    await db.update(zones).set({ splatStatus: "processing", splatNote: "Building true 3D on the GPU worker…" }).where(eq(zones.id, opts.zoneId));
    await run(recon, [opts.inputDir, outDir], { timeout: 3 * 3600_000 });
    const out = (await readdir(outDir)).find((f) => /\.(spz|ply)$/.test(f));
    if (!out) throw new Error("reconstruction produced no scene file");
    const buf = await readFile(path.join(outDir, out));
    const key = contentKey("priv", "raw-splat", sha256(buf), out.split(".").pop()!);
    await putBuffer(key, buf);
    const [imp] = await db
      .insert(mediaAssets)
      .values({ orgId: opts.orgId, spaceId: opts.spaceId, kind: "splat", storageKey: key, mime: out.endsWith(".ply") ? "model/ply" : "model/spz", bytes: buf.byteLength, sha256: sha256(buf), originalName: out, meta: { zoneId: opts.zoneId, ...opts.source } })
      .returning();
    await processSplatImport(imp.id);
    // Optional <outDir>/transform.json: upright alignment, metric scale and start point worked out by the worker.
    const tf = await readFile(path.join(outDir, "transform.json"), "utf8").then((t) => JSON.parse(t) as { align?: number[]; scale?: number; offset?: number[]; startYaw?: number; path?: number[][] }).catch(() => null);
    await db
      .update(zones)
      .set({ splatSource: "reconstructed", ...(tf?.align?.length === 4 ? { splatTransform: { flip: false, yawDeg: 0, scale: tf.scale ?? 1, align: tf.align, ...(tf.offset?.length === 3 ? { offset: tf.offset } : {}), ...(tf.path?.length ? { path: tf.path } : {}) }, ...(Number.isFinite(tf.startYaw) ? { startYaw: tf.startYaw } : {}) } : {}) })
      .where(eq(zones.id, opts.zoneId));
    return "done";
  } catch (e) {
    await db.update(zones).set({ splatStatus: "failed", splatNote: `Reconstruction failed: ${(e as Error).message.slice(0, 160)}` }).where(eq(zones.id, opts.zoneId));
    return "failed";
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function processVideo(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new PermanentJobError("asset missing");
  await db.update(mediaAssets).set({ status: "processing" }).where(eq(mediaAssets.id, assetId));
  const file = absPath(a.storageKey);
  let probe: { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    probe = JSON.parse(stdout);
  } catch {
    return reject(assetId, "Could not read the video file");
  }
  const duration = Number(probe.format?.duration ?? 0);
  const vs = probe.streams?.find((s) => s.codec_type === "video");
  if (!vs) return reject(assetId, "No video track found");
  if (duration < 10) return reject(assetId, "Walkthrough is too short: walk slowly around the room for at least 10 seconds");
  if (duration > 300) return reject(assetId, "Walkthrough is too long: keep each room under 5 minutes");
  const tmp = await mkdtemp(path.join(tmpdir(), "nz-frames-"));
  try {
    // Long side ≤ 1600 px whatever the orientation (a fixed width of 1280 upscaled portrait phone videos).
    await run("ffmpeg", ["-v", "error", "-i", file, "-vf", "fps=2,scale='if(gte(iw,ih),min(1600,iw),-2)':'if(gte(iw,ih),-2,min(1600,ih))'", "-q:v", "3", path.join(tmp, "f%04d.jpg")]);
    const frames = (await readdir(tmp)).filter((f) => f.endsWith(".jpg")).sort();
    const scored: { f: string; blur: number }[] = [];
    for (const f of frames) scored.push({ f, blur: await blurScore(await readFile(path.join(tmp, f))) });
    const sharpFrames = scored.filter((s) => s.blur >= BLUR_REJECT_THRESHOLD);
    const ratio = frames.length ? sharpFrames.length / frames.length : 0;
    if (ratio < 0.5) return reject(assetId, "Too much motion blur: walk slower and turn the lights on");
    const zoneId = (a.meta as { zoneId?: string }).zoneId ?? null;
    // Three sharp stills across the walk become photos of the room.
    const derived: string[] = [];
    for (const q of [0.2, 0.5, 0.8]) {
      const p = sharpFrames[Math.min(sharpFrames.length - 1, Math.floor(q * sharpFrames.length))];
      const buf = await readFile(path.join(tmp, p.f));
      const key = contentKey("priv", "raw-photo", sha256(buf), "jpg");
      await putBuffer(key, buf);
      const [photo] = await db
        .insert(mediaAssets)
        .values({ orgId: a.orgId, spaceId: a.spaceId, kind: "photo", storageKey: key, mime: "image/jpeg", bytes: buf.byteLength, sha256: sha256(buf), originalName: `${a.originalName ?? "video"} frame`, meta: { zoneId, fromVideo: a.id } })
        .returning();
      await processPhoto(photo.id);
      derived.push(photo.id);
    }
    let reconstruction = "needs_gpu_worker";
    if (process.env.NAZARIYA_RECON_CMD && zoneId) {
      reconstruction = await runReconstruction({ inputDir: tmp, zoneId, orgId: a.orgId, spaceId: a.spaceId!, source: { fromVideo: a.id } });
    } else if (zoneId) {
      await db
        .update(zones)
        .set({ splatStatus: "needs_gpu_worker", splatNote: "3D from video needs the GPU reconstruction worker (not configured on this server). Photos from your video are shown meanwhile." })
        .where(and(eq(zones.id, zoneId), sql`${zones.splatStatus} <> 'ready'`));
    }
    await db
      .update(mediaAssets)
      .set({ status: "ready", durationS: duration, width: vs.width ?? null, height: vs.height ?? null, meta: { ...(a.meta as object), frames: frames.length, sharpRatio: Math.round(ratio * 100) / 100, derivedPhotos: derived, reconstruction } })
      .where(eq(mediaAssets.id, assetId));
    return { frames: frames.length, ratio, derived, reconstruction };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export const MIN_STITCH_COVERAGE = 0.85;

/** Guided in-app 360°: stitch the phone frames (with gyroscope orientation) into an equirect, then treat as a 360° upload. */
/** 90th-percentile alignment correction (degrees) above which a capture is flagged as unsteady. */
const STEADY_P90_DEG = 4;

export async function stitchPanoCapture(assetId: string) {
  const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
  if (!a) throw new PermanentJobError("asset missing");
  const cap = (a.meta as { capture?: { frames: { alpha: number; beta: number; gamma: number; screenAngle: number; key: string }[]; fovHintDeg?: number | null } }).capture;
  if (!cap?.frames?.length) throw new PermanentJobError("no capture frames");
  const zoneId = (a.meta as { zoneId?: string }).zoneId ?? null;
  const ref = headingOf(cap.frames[0]);
  const frames: StitchFrame[] = [];
  for (const fr of cap.frames) {
    const image = await loadRaw(await getBuffer(fr.key));
    const longSide = Math.max(image.width, image.height);
    const scaled = longSide > 1280 ? await loadRaw(await sharp(await getBuffer(fr.key)).resize({ width: image.width >= image.height ? 1280 : undefined, height: image.height > image.width ? 1280 : undefined }).toBuffer()) : image;
    frames.push({ image: scaled, basis: tourBasis(fr, ref) });
  }
  const t0 = Date.now();
  const r = stitchEquirect(frames, { width: 4096, fovLongDeg: cap.fovHintDeg ?? undefined });
  // Heading corrections (gyroscope drift) are normal; what shows seams is photos that still disagree with
  // their neighbours after alignment, which happens when the phone moved instead of turning in place.
  const moved = r.bases.map((b, i) => (angleBetween(b.forward, frames[i].basis.forward) * 180) / Math.PI).sort((x, y) => x - y);
  const driftP90Deg = Math.round(moved[Math.min(moved.length - 1, Math.floor(moved.length * 0.9))] * 10) / 10;
  const disagreement = r.pairDisagreementP90Deg;
  const warning = disagreement !== null && disagreement > STEADY_P90_DEG ? "The phone moved during capture, so some seams may show. For a cleaner result keep the camera lens in one spot (step around the phone) or use a small tripod." : null;
  const stats = { fovLongDeg: r.fovLongDeg, coverage: Math.round(r.coverage * 1000) / 1000, stitchMs: Date.now() - t0, frames: frames.length, driftP90Deg, pairDisagreementP90Deg: disagreement, warning };
  if (r.coverage < MIN_STITCH_COVERAGE) {
    if (zoneId) await db.update(zones).set({ splatStatus: "failed", splatNote: null }).where(eq(zones.id, zoneId));
    await db.update(mediaAssets).set({ meta: { ...(a.meta as object), stitch: stats } }).where(eq(mediaAssets.id, assetId));
    return reject(assetId, `Parts of the room were missed (${Math.round(r.coverage * 100)}% covered). Capture again and follow every dot.`);
  }
  const jpeg = await sharp(r.pano.data, { raw: { width: r.pano.width, height: r.pano.height, channels: 3 } }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  await putBuffer(a.storageKey, jpeg);
  await db.update(mediaAssets).set({ sha256: sha256(jpeg), bytes: jpeg.byteLength, meta: { ...(a.meta as object), stitch: stats } }).where(eq(mediaAssets.id, assetId));
  // From here it is an ordinary 360° image: variants, room attach, automatic 3D build.
  const res = await processPano(assetId);
  return { ...stats, ...(res as object) };
}

export async function handleJob(job: ClaimedJob): Promise<Record<string, unknown>> {
  const p = job.payload as Record<string, string>;
  switch (job.kind) {
    case "media.process": {
      const [a] = await db.select({ kind: mediaAssets.kind }).from(mediaAssets).where(eq(mediaAssets.id, p.assetId));
      if (!a) throw new PermanentJobError("asset missing");
      if (a.kind === "photo") return (await processPhoto(p.assetId)) as Record<string, unknown>;
      if (a.kind === "pano") return (await processPano(p.assetId)) as Record<string, unknown>;
      if (a.kind === "video") return (await processVideo(p.assetId)) as Record<string, unknown>;
      if (a.kind === "splat") return (await processSplatImport(p.assetId)) as Record<string, unknown>;
      if (a.kind === "logo") return processLogo(p.assetId);
      return { skipped: a.kind };
    }
    case "scene.build_from_pano":
      return (await buildSceneFromPano(p.zoneId)) as Record<string, unknown>;
    case "capture.ar_room":
      return (await processArRoomCapture(p.assetId, {
        stitch: stitchEquirect,
        loadRaw,
        encodeJpeg: (pano) => sharp(pano.data, { raw: { width: pano.width, height: pano.height, channels: 3 } }).jpeg({ quality: 88, mozjpeg: true }).toBuffer(),
        processPano,
        reject,
      })) as Record<string, unknown>;
    case "recon.walkthrough":
      return (await processWalkthrough(p.sessionId, { runReconstruction, processPhoto })) as Record<string, unknown>;
    case "capture.stitch_pano":
      return (await stitchPanoCapture(p.assetId)) as Record<string, unknown>;
    default:
      throw new PermanentJobError(`unknown job kind ${job.kind}`);
  }
}

/** Deliver queued notifications (dev adapter logs them; production uses an SMS provider). */
export async function deliverNotifications(log: (s: string) => void = console.log) {
  const rows = await db.select().from(notifications).where(eq(notifications.status, "queued")).limit(50);
  for (const n of rows) {
    log(`[${n.channel}] → ${n.toPhone ?? "(no phone)"} ${n.template}: ${n.body}`);
    await db.update(notifications).set({ status: "sent", sentAt: new Date() }).where(eq(notifications.id, n.id));
  }
  return rows.length;
}
