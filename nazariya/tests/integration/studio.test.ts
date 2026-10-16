import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { apiListSpaces } from "@/server/api-v1";
import { verifyAuditChain, writeAudit } from "@/server/audit";
import { AuthError, loadSessionUser, loginWithOtp, requestOtp, userFromToken, verifyOtp, type SessionUser } from "@/server/auth";
import { closeDb, db, getSql } from "@/server/db";
import { DomainError, rootMessage } from "@/server/errors";
import { claimJobs, completeJob, enqueue, failJob } from "@/server/jobs";
import { handleUpload } from "@/server/media";
import { handleJob } from "@/server/pipeline/process";
import { buildSplatFromPano } from "@/server/pipeline/splat-from-pano";
import { loadRaw } from "@/server/pipeline/image";
import { auditEvents, hotspots, jobs, mediaAssets, organizations, spaces, users, zones } from "@/server/schema";
import * as S from "@/server/studio";

const run = promisify(execFile);
afterAll(async () => closeDb());

const phone = () => `+919${String(randomInt(0, 1e9)).padStart(9, "0")}`;
async function makeOwner(name = "Owner"): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ phone: phone(), name }).returning();
  const me = (await loadSessionUser(u.id))!;
  await S.createWorkspace(me, { name: `${name} Realty ${randomInt(0, 1e6)}`, yourName: name });
  return (await loadSessionUser(u.id))!;
}

async function drain() {
  for (let i = 0; i < 300; i++) {
    const js = await claimJobs("test", 5);
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

/** Seeded, structured test image (distinct per seed, sharp enough for the blur gate). */
async function testImage(width: number, height: number, seed = 1) {
  let x = seed || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x / 0x7fffffff);
  const grid = Array.from({ length: 12 * 9 }, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
  const buf = Buffer.alloc(width * height * 3);
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const c = grid[Math.floor((j / height) * 9) * 12 + Math.floor((i / width) * 12)];
      for (let k = 0; k < 3; k++) buf[(j * width + i) * 3 + k] = Math.max(0, Math.min(255, c[k] + (rnd() - 0.5) * 50));
    }
  return sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

const expectDomain = async (p: Promise<unknown>, re: RegExp) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && re.test(`${e.message} ${e.details.join(" ")}`));
const expectDb = async (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toSatisfy((e: unknown) => re.test(rootMessage(e)));

async function spaceWithPanoRoom(owner?: SessionUser) {
  const o = owner ?? (await makeOwner());
  const s = await S.createSpace(o, { name: "Test flat", kind: "apartment" });
  const z = await S.createZone(o, s.id, { label: "Living", roomType: "living" });
  await handleUpload(o, { name: "pano.jpg", bytes: await testImage(2048, 1024, randomInt(1, 1e6)) }, { spaceId: s.id, kind: "pano", zoneId: z.id });
  await drain();
  return { owner: o, space: s, zone: z };
}

describe("auth", () => {
  it("logs in with OTP and creates a session", async () => {
    const p = phone();
    const { devCode } = await requestOtp(p);
    const { token, user } = await loginWithOtp(p, devCode!);
    expect((await userFromToken(token))?.id).toBe(user.id);
  });
  it("locks after too many wrong codes and codes are single-use", async () => {
    const p = phone();
    const { devCode } = await requestOtp(p);
    const wrong = devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyOtp(p, wrong)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyOtp(p, devCode!)).rejects.toMatchObject({ code: "too_many_attempts" });
    const p2 = phone();
    const r2 = await requestOtp(p2);
    await verifyOtp(p2, r2.devCode!);
    await expect(verifyOtp(p2, r2.devCode!)).rejects.toBeInstanceOf(AuthError);
  });
});

describe("images → tour pipeline", () => {
  it("a 360° image becomes a 360° room AND an automatic 3D walkthrough", async () => {
    const { space } = await spaceWithPanoRoom();
    const [z] = await S.getTourZones(space.id);
    expect(z.pano?.url).toMatch(/^\/media\/pub\/pano\//);
    expect(z.pano?.mobileUrl).toBeTruthy();
    expect(z.splatStatus).toBe("ready");
    expect(z.splatSource).toBe("generated_from_pano");
    expect(z.splat?.url).toMatch(/\.spz$/);
    expect(z.splat?.splats).toBeGreaterThan(100_000);
  });

  it("rejects non-360 images, blurry photos and disguised files with clear reasons", async () => {
    const o = await makeOwner();
    const s = await S.createSpace(o, { name: "Rejects" });
    const z = await S.createZone(o, s.id, { label: "Room" });
    const notPano = await handleUpload(o, { name: "wide.jpg", bytes: await testImage(1600, 1200, 3) }, { spaceId: s.id, kind: "pano", zoneId: z.id });
    const flat = await sharp({ create: { width: 900, height: 700, channels: 3, background: "#d8d2c4" } }).jpeg().toBuffer();
    const blurry = await handleUpload(o, { name: "blur.jpg", bytes: flat }, { spaceId: s.id, kind: "photo", zoneId: z.id });
    await drain();
    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.spaceId, s.id));
    expect(rows.find((r) => r.id === notPano.id)?.rejectReason).toMatch(/2:1/);
    expect(rows.find((r) => r.id === blurry.id)?.rejectReason).toMatch(/blurry/);
    await expectDomain(handleUpload(o, { name: "x.jpg", bytes: new TextEncoder().encode("definitely not an image") }, { spaceId: s.id, kind: "photo" }), /valid photo/);
    await expectDomain(handleUpload(o, { name: "x.ply", bytes: await testImage(800, 600, 1) }, { spaceId: s.id, kind: "splat" }), /3D scan/);
  });

  it("photos attach to the room and strip metadata via re-encoding", async () => {
    const o = await makeOwner();
    const s = await S.createSpace(o, { name: "Photos only" });
    const z = await S.createZone(o, s.id, { label: "Bedroom" });
    const withExif = await sharp(await testImage(1200, 900, 7)).withMetadata({ exif: { IFD0: { Copyright: "secret-owner" } } }).jpeg().toBuffer();
    await handleUpload(o, { name: "p.jpg", bytes: withExif }, { spaceId: s.id, kind: "photo", zoneId: z.id });
    await drain();
    const [room] = await S.getTourZones(s.id);
    expect(room.photos).toHaveLength(1);
    const { getBuffer } = await import("@/server/storage");
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.spaceId, s.id));
    const pub = await getBuffer((asset.variants as { full: string }).full);
    const meta = await sharp(pub).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("imports 3D scans (.spz and .ply) and transcodes them to compact SPZ", async () => {
    const o = await makeOwner();
    const s = await S.createSpace(o, { name: "Scans" });
    const z1 = await S.createZone(o, s.id, { label: "SPZ room" });
    const z2 = await S.createZone(o, s.id, { label: "PLY room" });
    const spz = await buildSplatFromPano(await loadRaw(await testImage(2048, 1024, 11)), { w: 4, d: 5, h: 3, camH: 1.5 }, 256);
    await handleUpload(o, { name: "scan.spz", bytes: spz.bytes }, { spaceId: s.id, kind: "splat", zoneId: z1.id });
    // Minimal binary 3DGS PLY with 6,000 points.
    const n = 6000;
    const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
    const body = new Float32Array(n * props.length);
    for (let i = 0; i < n; i++) body.set([Math.cos(i) * 2, Math.sin(i * 0.7), Math.sin(i) * 2, 0.5, 0.2, -0.3, 3, -3.5, -3.5, -3.5, 1, 0, 0, 0], i * props.length);
    const ply = new Uint8Array([...new TextEncoder().encode(header), ...new Uint8Array(body.buffer)]);
    await handleUpload(o, { name: "scan.ply", bytes: ply }, { spaceId: s.id, kind: "splat", zoneId: z2.id });
    await drain();
    const rooms = await S.getTourZones(s.id);
    for (const r of rooms) {
      expect(r.splatStatus).toBe("ready");
      expect(r.splatSource).toBe("imported");
      expect(r.splat?.url).toMatch(/\.spz$/);
    }
    // A later 360° upload must not overwrite an imported scan.
    await handleUpload(o, { name: "pano.jpg", bytes: await testImage(2048, 1024, 12) }, { spaceId: s.id, kind: "pano", zoneId: z1.id });
    await drain();
    const [after] = (await S.getTourZones(s.id)).filter((r) => r.id === z1.id);
    expect(after.splatSource).toBe("imported");
    expect(after.pano?.url).toBeTruthy();
  });

  it("walkthrough video → photos now, 3D via the GPU worker hook", async () => {
    const o = await makeOwner();
    const s = await S.createSpace(o, { name: "Video" });
    const z = await S.createZone(o, s.id, { label: "Hall" });
    const dir = await mkdtemp(path.join(tmpdir(), "nz-vid-"));
    const mp4 = path.join(dir, "walk.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=12:size=1280x720:rate=10", "-pix_fmt", "yuv420p", mp4]);
    await handleUpload(o, { name: "walk.mp4", bytes: new Uint8Array(await readFile(mp4)) }, { spaceId: s.id, kind: "video", zoneId: z.id });
    await drain();
    let [room] = await S.getTourZones(s.id);
    expect(room.photos.length).toBe(3);
    expect(room.splatStatus).toBe("needs_gpu_worker");

    // Simulate the GPU worker: a command that writes a scene file into the output directory.
    const spz = await buildSplatFromPano(await loadRaw(await testImage(2048, 1024, 21)), { w: 4, d: 5, h: 3, camH: 1.5 }, 256);
    const fake = path.join(dir, "scene.spz");
    await writeFile(fake, spz.bytes);
    const script = path.join(dir, "recon.sh");
    await writeFile(script, `#!/bin/sh\ncp "${fake}" "$2/scene.spz"\n`);
    await chmod(script, 0o755);
    process.env.NAZARIYA_RECON_CMD = script;
    try {
      const z2 = await S.createZone(o, s.id, { label: "Hall 2" });
      await handleUpload(o, { name: "walk2.mp4", bytes: new Uint8Array(await readFile(mp4)) }, { spaceId: s.id, kind: "video", zoneId: z2.id });
      await drain();
      [room] = (await S.getTourZones(s.id)).filter((r) => r.id === z2.id);
      expect(room.splatStatus).toBe("ready");
      expect(room.splatSource).toBe("reconstructed");
    } finally {
      delete process.env.NAZARIYA_RECON_CMD;
    }
  });
});

describe("publishing and public access", () => {
  it("cannot publish without rooms or processed images; database guard as backstop", async () => {
    const o = await makeOwner();
    const s = await S.createSpace(o, { name: "Empty" });
    await expectDomain(S.publishSpace(o, s.id), /at least one room/);
    await expectDb(db.update(spaces).set({ status: "published" }).where(eq(spaces.id, s.id)), /without rooms/);
    await S.createZone(o, s.id, { label: "Bare room" });
    await expectDomain(S.publishSpace(o, s.id), /needs a processed/);
  });

  it("drafts are private, published tours are public; members can preview drafts", async () => {
    const { owner, space } = await spaceWithPanoRoom();
    expect(await S.getPublicTour(space.publicId)).toBeNull();
    const preview = await S.getPublicTour(space.publicId, owner);
    expect(preview?.preview).toBe(true);
    const stranger = await makeOwner("Stranger");
    expect(await S.getPublicTour(space.publicId, stranger)).toBeNull();
    await S.publishSpace(owner, space.id);
    const pub = await S.getPublicTour(space.publicId);
    expect(pub?.zones[0].splat?.url).toBeTruthy();
    expect(pub?.posterUrl).toMatch(/^\/media\/pub\//);
    expect(pub?.branding.showPoweredBy).toBe(true);
    await S.unpublishSpace(owner, space.id);
    expect(await S.getPublicTour(space.publicId)).toBeNull();
  });

  it("other workspaces cannot edit, upload to or read editor data of a space", async () => {
    const { space, zone } = await spaceWithPanoRoom();
    const other = await makeOwner("Other");
    await expectDomain(S.updateSpace(other, space.id, { name: "Hijack" }), /Not in your workspace/);
    await expectDomain(S.createZone(other, space.id, { label: "x" }), /Not in your workspace/);
    await expectDomain(handleUpload(other, { name: "p.jpg", bytes: await testImage(800, 600, 2) }, { spaceId: space.id, kind: "photo" }), /Not in your workspace/);
    await expectDomain(S.addHotspot(other, zone.id, { type: "info", yaw: 0, pitch: 0, title: "x" }), /Not in your workspace/);
    await expectDomain(S.spaceEditorData(other, space.id), /Not in your workspace/);
  });

  it("validates hotspots and cleans up doors when a room is deleted", async () => {
    const { owner, space, zone } = await spaceWithPanoRoom();
    const kitchen = await S.createZone(owner, space.id, { label: "Kitchen" });
    const foreign = await spaceWithPanoRoom();
    await expectDomain(S.addHotspot(owner, zone.id, { type: "door_to_zone", yaw: 0, pitch: 0, title: "Door", targetZoneId: foreign.zone.id }), /not in this space/);
    await expectDomain(S.addHotspot(owner, zone.id, { type: "link", yaw: 0, pitch: 0, title: "Brochure", url: "http://insecure.example/x.pdf" }), /https/);
    const door = await S.addHotspot(owner, zone.id, { type: "door_to_zone", yaw: 1, pitch: 0, title: "Kitchen", targetZoneId: kitchen.id });
    expect(door.position).toHaveLength(3);
    await S.deleteZone(owner, kitchen.id);
    expect(await db.select().from(hotspots).where(eq(hotspots.id, door.id))).toHaveLength(0);
  });
});

describe("embedding controls", () => {
  it("allowed domains drive frame-ancestors", async () => {
    const { owner, space } = await spaceWithPanoRoom();
    expect(await S.frameAncestorsFor(space.publicId)).toBe("*");
    await S.updateSpace(owner, space.id, { allowedDomains: ["https://www.Skyline.in/listings", "*.skyline.in", "  "] });
    const [row] = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(row.allowedDomains).toEqual(["www.skyline.in", "*.skyline.in"]);
    expect(await S.frameAncestorsFor(space.publicId)).toBe("'self' https://www.skyline.in http://www.skyline.in https://*.skyline.in http://*.skyline.in");
    await expectDomain(S.updateSpace(owner, space.id, { allowedDomains: ["not a domain"] }), /not a valid domain/);
  });

  it("branding: trial must show the Nazariya badge, Pro can white-label with a logo", async () => {
    const { owner, space } = await spaceWithPanoRoom();
    await S.publishSpace(owner, space.id);
    const org = owner.orgs[0];
    await expectDomain(S.updateWorkspaceBranding(owner, org.id, { primaryColor: "#7c3aed", showPoweredBy: false }), /Pro plan/);
    await db.update(organizations).set({ plan: "pro" }).where(eq(organizations.id, org.id));
    const logo = await handleUpload(owner, { name: "logo.png", bytes: await sharp(await testImage(600, 200, 5)).png().toBuffer() }, { kind: "logo" });
    await drain();
    await S.updateWorkspaceBranding(owner, org.id, { primaryColor: "#7c3aed", showPoweredBy: false, logoAssetId: logo.id });
    const t = await S.getPublicTour(space.publicId);
    expect(t?.branding).toMatchObject({ primaryColor: "#7c3aed", showPoweredBy: false });
    expect(t?.branding.logoUrl).toMatch(/\/media\/pub\/logo\//);
  });

  it("records view analytics with referrer host and aggregates stats", async () => {
    const { owner, space, zone } = await spaceWithPanoRoom();
    await S.publishSpace(owner, space.id);
    await S.recordViewEvent({ publicId: space.publicId, name: "tour_open", referrer: "https://www.skyline.in/flat-12", surface: "embed" });
    await S.recordViewEvent({ publicId: space.publicId, name: "tour_open", referrer: "https://www.skyline.in/flat-12", surface: "embed" });
    await S.recordViewEvent({ publicId: space.publicId, name: "zone_view", zoneId: zone.id, surface: "embed" });
    await S.recordViewEvent({ publicId: space.publicId, name: "tour_fallback", props: { reason: "webgl_context_lost" } });
    await expectDomain(S.recordViewEvent({ publicId: space.publicId, name: "evil_event" }), /Unknown event/);
    const st = await S.spaceStats(space.id);
    expect(st.opens).toBe(2);
    expect(st.byRef[0]).toMatchObject({ host: "www.skyline.in", n: 2 });
    expect(st.byZone[0]).toMatchObject({ zoneId: zone.id, n: 1 });
    expect(st.fallbacks[0]).toMatchObject({ reason: "webgl_context_lost", n: 1 });
  });
});

describe("API keys and REST API", () => {
  it("keys are shown once, stored hashed, scoped to the workspace and revocable", async () => {
    const { owner, space } = await spaceWithPanoRoom();
    await S.updateSpace(owner, space.id, { externalRef: "CRM-778" });
    await S.publishSpace(owner, space.id);
    const draft = await S.createSpace(owner, { name: "Draft not listed" });
    void draft;
    const { key, id } = await S.createApiKey(owner, "Website");
    expect(key).toMatch(/^nz_live_/);
    const stored = await db.execute(sql`select key_hash from api_keys where id = ${id}`);
    expect((stored[0] as { key_hash: string }).key_hash).not.toContain(key);
    const orgId = await S.orgFromApiKey(`Bearer ${key}`);
    expect(orgId).toBe(owner.orgs[0].id);
    const list = await apiListSpaces(orgId!, "https://tours.example", {});
    expect(list.map((x) => x.id)).toEqual([space.publicId]);
    expect(list[0]).toMatchObject({ embedUrl: `https://tours.example/embed/${space.publicId}`, externalRef: "CRM-778", rooms: 1, rooms3d: 1 });
    expect((await apiListSpaces(orgId!, "x", { externalRef: "CRM-778" })).length).toBe(1);
    expect((await apiListSpaces(orgId!, "x", { externalRef: "nope" })).length).toBe(0);
    const other = await makeOwner("Other");
    const { key: otherKey } = await S.createApiKey(other, "Theirs");
    expect((await apiListSpaces((await S.orgFromApiKey(`Bearer ${otherKey}`))!, "x", {})).length).toBe(0);
    await S.revokeApiKey(owner, id);
    expect(await S.orgFromApiKey(`Bearer ${key}`)).toBeNull();
    expect(await S.orgFromApiKey("Bearer nz_live_" + "x".repeat(32))).toBeNull();
    expect(await S.orgFromApiKey(null)).toBeNull();
  });
});

describe("platform integrity", () => {
  it("audit log is append-only and tampering is detected", async () => {
    await spaceWithPanoRoom();
    const [row] = await db.select().from(auditEvents).limit(1);
    await expectDb(db.update(auditEvents).set({ action: "x" }).where(eq(auditEvents.id, row.id)), /append-only/);
    await expectDb(db.delete(auditEvents).where(eq(auditEvents.id, row.id)), /append-only/);
    expect((await verifyAuditChain()).ok).toBe(true);
    const s = getSql();
    const [last] = await db.select().from(auditEvents).orderBy(sql`id desc`).limit(1);
    await s.unsafe("alter table audit_events disable trigger audit_events_no_update");
    try {
      await s`update audit_events set data = '{"tampered":true}'::jsonb where id = ${last.id}`;
      const v = await verifyAuditChain();
      expect(v).toMatchObject({ ok: false, brokenAtId: last.id });
    } finally {
      await s`update audit_events set data = ${JSON.stringify(last.data)}::jsonb where id = ${last.id}`;
      await s.unsafe("alter table audit_events enable trigger audit_events_no_update");
    }
    await Promise.all(Array.from({ length: 15 }, (_, i) => db.transaction((tx) => writeAudit(tx, { actorUserId: null, actorRole: "system", action: "test", subjectType: "t", subjectId: String(i) }))));
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it("job queue never hands one job to two workers", async () => {
    await db.delete(jobs).where(eq(jobs.kind, "notify.deliver"));
    for (let i = 0; i < 10; i++) await enqueue(db, "notify.deliver", { i });
    const res = await Promise.all(Array.from({ length: 5 }, (_, w) => claimJobs(`w${w}`, 3, ["notify.deliver"])));
    const ids = res.flat().map((j) => j.id);
    expect(new Set(ids).size).toBe(10);
    await db.delete(jobs).where(eq(jobs.kind, "notify.deliver"));
  });

  it("room ordering and rebuild of 3D after changing room shape", async () => {
    const { owner, space, zone } = await spaceWithPanoRoom();
    const b = await S.createZone(owner, space.id, { label: "Second" });
    await S.moveZone(owner, b.id, -1);
    const order = (await S.getTourZones(space.id)).map((z) => z.label);
    expect(order).toEqual(["Second", "Living"]);
    await S.updateZone(owner, zone.id, { roomDims: { w: 6, d: 7 } });
    await S.requestSplatBuild(owner, zone.id);
    await drain();
    const [z] = await db.select().from(zones).where(eq(zones.id, zone.id));
    expect(z.splatStatus).toBe("ready");
    expect(z.roomDims).toMatchObject({ w: 6, d: 7 });
  });
});
