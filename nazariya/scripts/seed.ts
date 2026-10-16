// Seeds demo workspaces and tours through the real services (uploads → processing → 3D build → publish).
//
// Logins (OTP codes appear at /dev/outbox and in API responses while DEV_TOOLS=1):
//   +91 90000 00002  owner of "Nazariya Demo" (published demo tours, Pro plan)
//   +91 90000 00001  owner of "Skyline Homes" (trial workspace with a draft space)
//   +91 90000 00009  platform admin
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadSessionUser, type SessionUser } from "../src/server/auth";
import { closeDb, db } from "../src/server/db";
import { DEMO_WORKSPACE_NAME } from "../src/server/demo";
import { claimJobs, completeJob, failJob } from "../src/server/jobs";
import { handleUpload } from "../src/server/media";
import { deliverNotifications, handleJob } from "../src/server/pipeline/process";
import { equirectToPerspective, loadRaw } from "../src/server/pipeline/image";
import { pathExit, roomOutlinePlan, yawTowards, type PlanPlacement } from "../src/lib/floorplan";
import { positionFromYawPitch, type RoomDims } from "../src/lib/pano-geometry";
import { setZonePlan } from "../src/server/house";
import { hotspots, jobs, organizations, spaces, users, zones } from "../src/server/schema";
import { addHotspot, createApiKey, createSpace, createWorkspace, createZone, publishSpace, updateSpace, updateZone } from "../src/server/studio";

const PANO_DIR = path.resolve("assets/source");
const log = (...a: unknown[]) => console.log("•", ...a);

async function user(phone: string, name: string, roles: string[] = []): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ phone, name, roles }).onConflictDoUpdate({ target: users.phone, set: { name, roles } }).returning();
  return (await loadSessionUser(u.id))!;
}

async function drain(label: string) {
  let n = 0;
  for (;;) {
    const claimed = await claimJobs("seed", 4);
    for (const j of claimed) {
      try {
        await completeJob(j.id, await handleJob(j));
      } catch (e) {
        await failJob(j, e);
      }
      n++;
    }
    if (!claimed.length) {
      const [{ q }] = await db.select({ q: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.status, "queued"));
      if (!q) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  await deliverNotifications(() => {});
  log(`${label}: ${n} job(s)`);
}

async function placeRooms(owner: SessionUser, ids: Record<string, string>, layout: Record<string, [number, number]>) {
  for (const [label, [x, z]] of Object.entries(layout)) await setZonePlan(owner, ids[label], { x, z, rotDeg: 0 });
  const rows = await db.select().from(zones).where(inArray(zones.id, Object.values(ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const h of await db.select().from(hotspots).where(and(inArray(hotspots.zoneId, Object.values(ids)), eq(hotspots.type, "door_to_zone")))) {
    const a = byId.get(h.zoneId)!, b = h.targetZoneId ? byId.get(h.targetZoneId) : null;
    const pa = a.plan as PlanPlacement | null, pb = b?.plan as PlanPlacement | null;
    if (!pa || !pb) continue;
    const door = pathExit([[pa.x, pa.z], [pb.x, pb.z]], roomOutlinePlan(a.roomDims as RoomDims, pa)) ?? [(pa.x + pb.x) / 2, (pa.z + pb.z) / 2];
    const yaw = yawTowards(pa, door);
    await db.update(hotspots).set({ yaw, position: positionFromYawPitch(yaw, h.pitch, a.roomDims as RoomDims) }).where(eq(hotspots.id, h.id));
  }
}

interface RoomSpec {
  label: string;
  type: string;
  pano: string;
  dims: { w: number; d: number; h: number; camH: number };
  photos?: number[]; // yaws for extra photos rendered from the pano (simulates a photographer's stills)
}

async function buildSpace(owner: SessionUser, spec: { name: string; kind: string; address?: string; description: string; externalRef?: string; rooms: RoomSpec[] }) {
  const s = await createSpace(owner, { name: spec.name, kind: spec.kind as "apartment", address: spec.address ?? null, description: spec.description, externalRef: spec.externalRef ?? null });
  const ids: Record<string, string> = {};
  for (const r of spec.rooms) {
    const z = await createZone(owner, s.id, { label: r.label, roomType: r.type });
    await updateZone(owner, z.id, { roomDims: r.dims });
    ids[r.label] = z.id;
    const pano = await readFile(path.join(PANO_DIR, `${r.pano}.jpg`));
    await handleUpload(owner, { name: `${r.pano}.jpg`, bytes: pano }, { spaceId: s.id, kind: "pano", zoneId: z.id });
    if (r.photos?.length) {
      const raw = await loadRaw(pano, 2048);
      for (const yaw of r.photos) {
        const photo = await equirectToPerspective(raw, { yaw, pitch: -0.08, width: 1280, height: 960, hfovDeg: 78 });
        await handleUpload(owner, { name: `${r.pano}-${yaw}.jpg`, bytes: photo }, { spaceId: s.id, kind: "photo", zoneId: z.id });
      }
    }
  }
  return { space: s, ids };
}

async function main() {
  if (process.env.DEV_TOOLS !== "1") throw new Error("Run the seed with DEV_TOOLS=1 (see .env.local)");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(spaces);
  if (n > 0 && !process.argv.includes("--force")) {
    console.log("Database already has spaces. Run `npm run db:reset` first (or pass --force).");
    return;
  }
  await user("+919000000009", "Platform Admin", ["admin"]);
  let demo = await user("+919000000002", "Demo Owner");
  let skyline = await user("+919000000001", "Riya Malhotra");
  const demoOrg = await createWorkspace(demo, { name: DEMO_WORKSPACE_NAME, yourName: "Demo Owner", website: "nazariya.app" });
  await db.update(organizations).set({ plan: "pro" }).where(eq(organizations.id, demoOrg.id));
  await createWorkspace(skyline, { name: "Skyline Homes", yourName: "Riya Malhotra", website: "skylinehomes.in" });
  demo = (await loadSessionUser(demo.id))!;
  skyline = (await loadSessionUser(skyline.id))!;
  log("workspaces created");

  const apt = await buildSpace(demo, {
    name: "2BHK Apartment · Lajpat Nagar",
    kind: "apartment",
    address: "Lajpat Nagar IV, New Delhi",
    description: "Semi-furnished 2BHK with a park-facing living room, modular kitchen and two bathrooms.",
    externalRef: "LN-2BHK-204",
    rooms: [
      { label: "Living room", type: "living", pano: "cayley_interior", dims: { w: 5.5, d: 6.5, h: 3.0, camH: 1.5 }, photos: [0, 2.2] },
      { label: "Bedroom", type: "bedroom", pano: "lythwood_room", dims: { w: 4.0, d: 4.6, h: 2.9, camH: 1.5 }, photos: [0] },
      { label: "Kitchen", type: "kitchen", pano: "kiara_interior", dims: { w: 4.5, d: 5.0, h: 2.9, camH: 1.5 } },
      { label: "Bathroom", type: "bathroom", pano: "modern_bathroom", dims: { w: 2.6, d: 3.2, h: 2.7, camH: 1.5 } },
    ],
  });
  const hotel = await buildSpace(demo, {
    name: "Hotel Deluxe Room",
    kind: "hotel_room",
    description: "Deluxe double room with work desk and en-suite bathroom.",
    rooms: [
      { label: "Deluxe room", type: "room", pano: "hotel_room", dims: { w: 3.8, d: 4.6, h: 2.8, camH: 1.5 }, photos: [0] },
      { label: "Bathroom", type: "bathroom", pano: "bathroom", dims: { w: 2.4, d: 3.0, h: 2.7, camH: 1.5 } },
    ],
  });
  const villa = await buildSpace(demo, {
    name: "Villa · Vasant Kunj",
    kind: "villa",
    description: "Independent villa with a double-height hall, reading lounge and terrace.",
    rooms: [
      { label: "Hall", type: "living", pano: "photo_studio_loft_hall", dims: { w: 6, d: 7, h: 3.4, camH: 1.5 } },
      { label: "Reading lounge", type: "living", pano: "reading_room", dims: { w: 4.6, d: 5.2, h: 3.0, camH: 1.5 } },
      { label: "Master bedroom", type: "bedroom", pano: "brown_photostudio_04", dims: { w: 4.5, d: 5, h: 3, camH: 1.5 } },
      { label: "Terrace", type: "balcony", pano: "veranda", dims: { w: 4, d: 5, h: 3, camH: 1.5 } },
    ],
  });
  const pg = await buildSpace(demo, {
    name: "Co-living Room · North Campus",
    kind: "room",
    description: "Attic double-sharing room with skylights, plus the common café lounge.",
    rooms: [
      { label: "Attic room", type: "bedroom", pano: "pine_attic", dims: { w: 4.2, d: 5.0, h: 2.7, camH: 1.45 } },
      { label: "Café lounge", type: "common", pano: "comfy_cafe", dims: { w: 6, d: 7, h: 3.1, camH: 1.5 } },
    ],
  });
  const draft = await buildSpace(skyline, {
    name: "Tower B · Flat 1204 (draft)",
    kind: "apartment",
    externalRef: "TB-1204",
    description: "Sample flat, work in progress.",
    rooms: [{ label: "Living", type: "living", pano: "lebombo", dims: { w: 5, d: 6, h: 3, camH: 1.5 } }],
  });
  await drain("image processing + automatic 3D builds");

  // Hotspots: doors between rooms + features.
  const A = apt.ids;
  await addHotspot(demo, A["Living room"], { type: "door_to_zone", yaw: 1.8, pitch: -0.05, title: "Bedroom", targetZoneId: A["Bedroom"] });
  await addHotspot(demo, A["Living room"], { type: "door_to_zone", yaw: -1.9, pitch: -0.05, title: "Kitchen", targetZoneId: A["Kitchen"] });
  await addHotspot(demo, A["Living room"], { type: "view", yaw: 0.2, pitch: 0.05, title: "Park-facing windows", body: "Morning sun all year; the balcony overlooks the block park." });
  await addHotspot(demo, A["Living room"], { type: "link", yaw: -0.5, pitch: -0.25, title: "Floor plan (PDF)", url: "https://example.com/floor-plan.pdf" });
  await addHotspot(demo, A["Bedroom"], { type: "amenity", yaw: -1.5, pitch: 0.05, title: "Built-in wardrobe", body: "Floor-to-ceiling, three doors." });
  await addHotspot(demo, A["Bedroom"], { type: "door_to_zone", yaw: 3.0, pitch: -0.05, title: "Living room", targetZoneId: A["Living room"] });
  await addHotspot(demo, A["Kitchen"], { type: "amenity", yaw: 0.6, pitch: -0.2, title: "Modular kitchen", body: "Chimney, hob and RO purifier included." });
  await addHotspot(demo, A["Kitchen"], { type: "door_to_zone", yaw: 2.6, pitch: -0.05, title: "Bathroom", targetZoneId: A["Bathroom"] });
  await addHotspot(demo, A["Bathroom"], { type: "door_to_zone", yaw: -2.8, pitch: -0.05, title: "Living room", targetZoneId: A["Living room"] });
  await addHotspot(demo, hotel.ids["Deluxe room"], { type: "door_to_zone", yaw: -2.4, pitch: -0.05, title: "Bathroom", targetZoneId: hotel.ids["Bathroom"] });
  await addHotspot(demo, hotel.ids["Deluxe room"], { type: "amenity", yaw: 0.4, pitch: -0.1, title: "Work desk & fast Wi-Fi" });
  await addHotspot(demo, hotel.ids["Bathroom"], { type: "door_to_zone", yaw: 2.9, pitch: -0.05, title: "Back to room", targetZoneId: hotel.ids["Deluxe room"] });
  const V = villa.ids;
  await addHotspot(demo, V["Hall"], { type: "door_to_zone", yaw: 1.2, pitch: -0.05, title: "Reading lounge", targetZoneId: V["Reading lounge"] });
  await addHotspot(demo, V["Hall"], { type: "door_to_zone", yaw: -1.2, pitch: -0.05, title: "Terrace", targetZoneId: V["Terrace"] });
  await addHotspot(demo, V["Reading lounge"], { type: "door_to_zone", yaw: 2.5, pitch: -0.05, title: "Master bedroom", targetZoneId: V["Master bedroom"] });
  await addHotspot(demo, V["Master bedroom"], { type: "door_to_zone", yaw: -2.5, pitch: -0.05, title: "Hall", targetZoneId: V["Hall"] });
  await addHotspot(demo, V["Terrace"], { type: "door_to_zone", yaw: 3.0, pitch: -0.05, title: "Hall", targetZoneId: V["Hall"] });
  await addHotspot(demo, pg.ids["Attic room"], { type: "amenity", yaw: 0.9, pitch: 0.3, title: "Skylights", body: "Natural light all day." });
  await addHotspot(demo, pg.ids["Attic room"], { type: "door_to_zone", yaw: 2.9, pitch: -0.05, title: "Café lounge", targetZoneId: pg.ids["Café lounge"] });
  await addHotspot(demo, pg.ids["Café lounge"], { type: "door_to_zone", yaw: -2.6, pitch: -0.05, title: "Attic room", targetZoneId: pg.ids["Attic room"] });
  log("hotspots added");

  // Floor plans: rooms laid out side by side; each door is re-aimed at the real doorway on the plan.
  await placeRooms(demo, A, { "Living room": [0, 0], Bedroom: [4.85, -0.8], Kitchen: [-5.1, -0.75], Bathroom: [-4.0, 3.45] });
  await placeRooms(demo, hotel.ids, { "Deluxe room": [0, 0], Bathroom: [-3.2, -0.8] });
  await placeRooms(demo, V, { Hall: [0, 0], "Reading lounge": [5.4, -0.9], "Master bedroom": [5.35, 4.3], Terrace: [-5.1, 0] });
  await placeRooms(demo, pg.ids, { "Attic room": [0, 0], "Café lounge": [5.2, 0] });
  log("floor plans laid out");

  await updateSpace(demo, villa.space.id, { settings: { autoRotate: true }, allowedDomains: ["localhost:3100", "*.skylinehomes.in"] });
  for (const s of [apt, hotel, villa, pg]) await publishSpace(demo, s.space.id);
  log("demo tours published");
  void draft;

  const key = await createApiKey(demo, "Demo website");
  const ready = await db.select({ n: sql<number>`count(*)::int` }).from(zones).where(eq(zones.splatStatus, "ready"));
  console.log(`\nSeed complete: ${ready[0].n} rooms with 3D walkthroughs.`);
  console.log(`Demo workspace API key (shown once): ${key.key}`);
  console.log(`Featured embed: /embed/${apt.space.publicId}   Share: /t/${apt.space.publicId}`);
  console.log(`Example customer site: /examples/agency-site.html?space=${apt.space.publicId}`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
