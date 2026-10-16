import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { anglesFor, headingOf, panoTargets, tourBasis } from "@/lib/orientation";
import { loadSessionUser, type SessionUser } from "@/server/auth";
import { createCaptureLink, resolveCaptureToken, submitPanoCapture } from "@/server/capture";
import { closeDb, db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { claimJobs, completeJob, failJob } from "@/server/jobs";
import { loadRaw, renderPerspectiveBasis } from "@/server/pipeline/image";
import { handleJob } from "@/server/pipeline/process";
import { overlapError, stitchEquirect } from "@/server/pipeline/stitch";
import { captureLinks, jobs, mediaAssets, users, zones } from "@/server/schema";
import * as S from "@/server/studio";

afterAll(async () => closeDb());

async function owner(): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ phone: `+919${String(randomInt(0, 1e9)).padStart(9, "0")}`, name: "Cap" }).returning();
  const me = (await loadSessionUser(u.id))!;
  await S.createWorkspace(me, { name: `Capture Co ${randomInt(0, 1e6)}`, yourName: "Cap" });
  return (await loadSessionUser(u.id))!;
}

async function drain() {
  for (let i = 0; i < 200; i++) {
    const js = await claimJobs("cap-test", 3);
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

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
const D = 180 / Math.PI;

/** Simulate a phone capture: render each target view from a real panorama, with gyroscope noise. */
async function simulateCapture(noiseDeg: number, fov = 64, size: [number, number] = [540, 720], tiltNoiseDeg = noiseDeg) {
  const pano = await loadRaw(await readFile("assets/source/cayley_interior.jpg"), 2048);
  const a0 = 211;
  const ref = headingOf(anglesFor(0, 0, a0));
  return panoTargets().map((t) => {
    const truth = anglesFor(t.yaw * D, t.pitch * D, a0);
    const measured = { ...anglesFor(t.yaw * D + rnd() * noiseDeg * 2, t.pitch * D + rnd() * tiltNoiseDeg * 2, a0), gamma: rnd() * tiltNoiseDeg * 1.5 };
    const image = renderPerspectiveBasis(pano, tourBasis(truth, ref), fov, size[0], size[1]);
    return { image, measured, truth, ref };
  });
}

describe("sensor-guided stitching", () => {
  it("reconstructs a 360° panorama exactly when orientation is perfect", async () => {
    const sim = await simulateCapture(0);
    const r = stitchEquirect(sim.map((s) => ({ image: s.image, basis: tourBasis(s.measured, s.ref) })), { width: 1024 });
    expect(r.fovLongDeg).toBeGreaterThanOrEqual(62);
    expect(r.fovLongDeg).toBeLessThanOrEqual(66);
    expect(r.coverage).toBeGreaterThan(0.99);
    const gt = await loadRaw(await readFile("assets/source/cayley_interior.jpg"), 1024);
    let se = 0, n = 0;
    for (let j = Math.floor(512 / 6); j < Math.ceil((512 * 5) / 6); j++)
      for (let i = 0; i < 1024; i++)
        for (let c = 0; c < 3; c++) {
          const d = r.pano.data[(j * 1024 + i) * 3 + c] - gt.data[(j * 1024 + i) * 3 + c];
          se += d * d;
          n++;
        }
    expect(10 * Math.log10((255 * 255) / (se / n))).toBeGreaterThan(30);
  });

  it("estimates the unknown camera FOV and reduces seam error caused by gyroscope noise", async () => {
    const sim = await simulateCapture(1.5, 70);
    const frames = sim.map((s) => ({ image: s.image, basis: tourBasis(s.measured, s.ref) }));
    const before = overlapError(frames, 70, 512);
    const r = stitchEquirect(frames, { width: 1024 });
    expect(Math.abs(r.fovLongDeg - 70)).toBeLessThanOrEqual(3);
    const after = overlapError(frames.map((f, i) => ({ ...f, basis: r.bases[i] })), 70, 512);
    expect(after).toBeLessThan(before * 0.8);
    expect(r.coverage).toBeGreaterThan(0.98);
  });
});

describe("sensor-guided stitching with real-world errors", () => {
  it("recovers heading drift well beyond ±3° (phones know their tilt from gravity, not their heading)", async () => {
    // Real phones: heading off by several degrees per photo, tilt accurate to under a degree.
    seed = 29;
    const sim = await simulateCapture(6, 64, [450, 800], 0.7);
    const frames = sim.map((s) => ({ image: s.image, basis: tourBasis(s.measured, s.ref) }));
    const before = overlapError(frames, 64, 512);
    const r = stitchEquirect(frames, { width: 1024, fovLongDeg: 64 });
    const after = overlapError(frames.map((f, i) => ({ ...f, basis: r.bases[i] })), 64, 512);
    expect(after).toBeLessThan(before * 0.5);
    // Compare with the true camera directions (up to one shared heading offset, which is arbitrary).
    const D = 180 / Math.PI;
    const err = (bs: { forward: number[] }[]) => {
      const dy = sim.map((s, i) => {
        const t = tourBasis(s.truth, s.ref).forward, f = bs[i].forward;
        if (Math.abs(t[1]) > 0.9) return NaN; // heading is meaningless straight up/down
        return ((((Math.atan2(f[0], -f[2]) - Math.atan2(t[0], -t[2])) * D + 540) % 360) - 180);
      }).filter(Number.isFinite);
      const med = [...dy].sort((a, b) => a - b)[dy.length >> 1];
      return dy.map((x) => Math.abs(x - med));
    };
    const sensorErr = err(frames.map((f) => f.basis)), stitchErr = err(r.bases);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    expect(Math.max(...sensorErr)).toBeGreaterThan(4);
    expect(median(stitchErr)).toBeLessThan(0.75);
    expect(Math.max(...stitchErr)).toBeLessThan(2);
    expect(r.coverage).toBeGreaterThan(0.98);
  });
});

describe("in-app 360° capture flow", () => {
  it("phone frames + orientation → stitched 360° room → automatic 3D", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "Captured flat" });
    const z = await S.createZone(o, s.id, { label: "Living" });
    const sim = await simulateCapture(1, 64, [600, 800]);
    const frames = await Promise.all(sim.map(async (f, i) => ({ name: `f${i}.jpg`, bytes: new Uint8Array(await sharp(f.image.data, { raw: { width: f.image.width, height: f.image.height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer()) })));
    const asset = await submitPanoCapture(o, { spaceId: s.id, zoneId: z.id, meta: { device: "test-phone", frames: sim.map((f) => ({ ...f.measured, screenAngle: 0 })) }, frames });
    const [queued] = await db.select().from(zones).where(eq(zones.id, z.id));
    expect(queued.splatNote).toMatch(/Stitching 360°/);
    await drain();
    const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(a.status).toBe("ready");
    expect(a.width).toBe(4096);
    expect((a.meta as { stitch: { coverage: number } }).stitch.coverage).toBeGreaterThan(0.95);
    expect((a.meta as { capture: { source: string } }).capture.source).toBe("in_app_360");
    const [room] = await S.getTourZones(s.id);
    expect(room.pano?.url).toBeTruthy();
    expect(room.splatStatus).toBe("ready");
  });

  it("rejects incomplete captures and mismatched data", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "Partial" });
    const z = await S.createZone(o, s.id, { label: "Room" });
    const jpg = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#888" } }).jpeg().toBuffer());
    const meta = (n: number) => ({ frames: Array.from({ length: n }, (_, i) => anglesFor(i * 30, 0)) });
    await expect(submitPanoCapture(o, { spaceId: s.id, zoneId: z.id, meta: meta(5), frames: Array(5).fill({ name: "f.jpg", bytes: jpg }) })).rejects.toThrow();
    await expect(submitPanoCapture(o, { spaceId: s.id, zoneId: z.id, meta: meta(12), frames: Array(11).fill({ name: "f.jpg", bytes: jpg }) })).rejects.toBeInstanceOf(DomainError);
    const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).png().toBuffer());
    await expect(submitPanoCapture(o, { spaceId: s.id, zoneId: z.id, meta: meta(12), frames: Array(12).fill({ name: "f.png", bytes: png }) })).rejects.toThrow(/not a JPEG/);
    // A capture that only covers the middle row is stitched but rejected for missing coverage.
    const sim = await simulateCapture(0, 64, [300, 400]);
    const ring = sim.slice(0, 12);
    const frames = await Promise.all(ring.map(async (f, i) => ({ name: `f${i}.jpg`, bytes: new Uint8Array(await sharp(f.image.data, { raw: { width: f.image.width, height: f.image.height, channels: 3 } }).jpeg().toBuffer()) })));
    const asset = await submitPanoCapture(o, { spaceId: s.id, zoneId: z.id, meta: { frames: ring.map((f) => f.measured) }, frames });
    await drain();
    const [a] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(a.status).toBe("rejected");
    expect(a.rejectReason).toMatch(/missed/);
  });
});

describe("capture links", () => {
  it("work without login, are scoped to one space and expire", async () => {
    const o = await owner();
    const s = await S.createSpace(o, { name: "Linked" });
    const z = await S.createZone(o, s.id, { label: "Room" });
    const { token } = await createCaptureLink(o, s.id, z.id);
    const ctx = await resolveCaptureToken(token);
    expect(ctx).toMatchObject({ spaceId: s.id, zoneId: z.id });
    expect(ctx?.user.id).toBe(o.id);
    expect(await resolveCaptureToken("x".repeat(32))).toBeNull();
    expect(await resolveCaptureToken(null)).toBeNull();
    const stored = await db.select().from(captureLinks).where(eq(captureLinks.spaceId, s.id));
    expect(stored[0].tokenHash).not.toContain(token);
    await db.update(captureLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(captureLinks.spaceId, s.id));
    expect(await resolveCaptureToken(token)).toBeNull();
    const other = await owner();
    await expect(createCaptureLink(other, s.id, null)).rejects.toBeInstanceOf(DomainError);
  });
});
