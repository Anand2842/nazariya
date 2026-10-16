// Seeds a realistic Delhi demo through the real domain services (no direct table writes except
// clearly-marked demo shortcuts such as back-dating a confirmation to show the "stale" state).
//
// Demo phones (OTP codes appear on /dev/outbox and in API responses while DEV_TOOLS=1):
//   +91 90000 00001 renter Aarav     +91 90000 00002 broker Rohit     +91 90000 00003 PG operator Meera
//   +91 90000 00004 hotel Vikram     +91 90000 00005 owner Sunita     +91 90000 00006 broker Neha
//   +91 90000 00007 Quick Rentals (suspicious demo)                   +91 90000 00009 admin
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { addDays, todayIST } from "../src/lib/availability";
import { rupeesToPaise } from "../src/lib/money";
import { loadSessionUser, type SessionUser } from "../src/server/auth";
import { closeDb, db } from "../src/server/db";
import { createBookingRequest, createEnquiry, proposeVisits, updateVisit } from "../src/server/enquiries";
import { claimJobs, completeJob, failJob } from "../src/server/jobs";
import {
  addHotspot,
  createListing,
  createOrganization,
  createProperty,
  createZone,
  publishListing,
  requestSplatBuild,
  setBedStatus,
  setNightlyInventory,
  setPricePlan,
  setUnitAvailability,
  updateZone,
} from "../src/server/listings";
import { handleUpload, startCaptureSession } from "../src/server/media";
import { deliverNotifications, handleJob } from "../src/server/pipeline/process";
import { equirectToPerspective, loadRaw } from "../src/server/pipeline/image";
import { beds, jobs, listings, localities, users, zones } from "../src/server/schema";
import { contentKey, putBuffer, sha256 } from "../src/server/storage";
import {
  createReport,
  decideCheck,
  freshnessSweep,
  requestOwnerConfirmation,
  runDedupeForProperty,
  sendOwnerOtp,
  ownerRespond,
  submitAuthorizationDocument,
  verifyDigilocker,
  verifyPan,
} from "../src/server/trust";
import { writeAudit } from "../src/server/audit";

const LOCALITIES = [
  { id: "kamla-nagar", name: "Kamla Nagar", zone: "North Delhi", lat: 28.6812, lng: 77.2045, nearestMetro: "Vishwavidyalaya" },
  { id: "mukherjee-nagar", name: "Mukherjee Nagar", zone: "North Delhi", lat: 28.7068, lng: 77.2135, nearestMetro: "GTB Nagar" },
  { id: "laxmi-nagar", name: "Laxmi Nagar", zone: "East Delhi", lat: 28.6304, lng: 77.2773, nearestMetro: "Laxmi Nagar" },
  { id: "lajpat-nagar", name: "Lajpat Nagar", zone: "South Delhi", lat: 28.5677, lng: 77.2433, nearestMetro: "Lajpat Nagar" },
  { id: "saket", name: "Saket", zone: "South Delhi", lat: 28.5245, lng: 77.2066, nearestMetro: "Saket" },
  { id: "malviya-nagar", name: "Malviya Nagar", zone: "South Delhi", lat: 28.5355, lng: 77.21, nearestMetro: "Malviya Nagar" },
  { id: "hauz-khas", name: "Hauz Khas", zone: "South Delhi", lat: 28.5494, lng: 77.2001, nearestMetro: "Hauz Khas" },
  { id: "dwarka-sector-12", name: "Dwarka Sector 12", zone: "South West Delhi", lat: 28.5921, lng: 77.046, nearestMetro: "Dwarka Sector 12" },
  { id: "karol-bagh", name: "Karol Bagh", zone: "Central Delhi", lat: 28.6519, lng: 77.1909, nearestMetro: "Karol Bagh" },
  { id: "paharganj", name: "Paharganj", zone: "Central Delhi", lat: 28.6448, lng: 77.2167, nearestMetro: "RK Ashram Marg" },
  { id: "rajouri-garden", name: "Rajouri Garden", zone: "West Delhi", lat: 28.6415, lng: 77.1209, nearestMetro: "Rajouri Garden" },
  { id: "mayur-vihar", name: "Mayur Vihar Phase 1", zone: "East Delhi", lat: 28.6046, lng: 77.295, nearestMetro: "Mayur Vihar Phase-1" },
  { id: "satya-niketan", name: "Satya Niketan", zone: "South Delhi", lat: 28.588, lng: 77.168, nearestMetro: "Durgabai Deshmukh South Campus" },
  { id: "vasant-kunj", name: "Vasant Kunj", zone: "South West Delhi", lat: 28.52, lng: 77.158, nearestMetro: "Chhatarpur" },
  { id: "connaught-place", name: "Connaught Place", zone: "Central Delhi", lat: 28.6315, lng: 77.2167, nearestMetro: "Rajiv Chowk" },
];

const log = (...a: unknown[]) => console.log("•", ...a);
const PANO_DIR = path.resolve("assets/source");

async function user(phone: string, name: string, roles: string[] = ["renter"]): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ phone, name, roles }).onConflictDoUpdate({ target: users.phone, set: { name, roles } }).returning();
  // Phone ownership is proven by OTP at login; seeded demo accounts get the same check recorded.
  const { addCheck } = await import("../src/server/trust");
  await db.transaction((tx) =>
    addCheck(tx, { subjectType: "user", subjectId: u.id, checkType: "phone_otp", status: "passed", method: "automated", data: { seeded: true } }),
  );
  return (await loadSessionUser(u.id))!;
}

async function refresh(u: SessionUser) {
  return (await loadSessionUser(u.id))!;
}

async function drain(label: string) {
  let processed = 0;
  for (;;) {
    const claimed = await claimJobs("seed", 4);
    for (const j of claimed) {
      try {
        await completeJob(j.id, await handleJob(j));
      } catch (e) {
        await failJob(j, e);
        console.error("  job failed", j.kind, (e as Error).message);
      }
      processed++;
    }
    if (!claimed.length) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.status, "queued"));
      if (!n) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await deliverNotifications(() => {});
  log(`${label}: processed ${processed} job(s)`);
}

async function confirmOwner(lister: SessionUser, authorizationId: string, accept = true) {
  await requestOwnerConfirmation(lister, authorizationId);
  const { devCode } = await sendOwnerOtp(authorizationId);
  if (!devCode) throw new Error("DEV_TOOLS must be 1 to seed (owner OTP echo)");
  await ownerRespond(authorizationId, devCode, accept);
}

/** Generates a clearly-labelled sample document image for the private evidence store. */
async function demoDocument(title: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="100%" height="100%" fill="#fff"/><rect x="20" y="20" width="860" height="560" fill="none" stroke="#999" stroke-width="4"/><text x="50" y="110" font-family="sans-serif" font-size="40" fill="#222">${title}</text><text x="50" y="190" font-family="sans-serif" font-size="28" fill="#c00">SAMPLE DOCUMENT FOR LOCAL DEMO</text><text x="50" y="250" font-family="sans-serif" font-size="24" fill="#555">Not a real record. Generated by scripts/seed.ts</text></svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const hash = sha256(buf);
  const key = contentKey("priv", "evidence", hash, "png");
  await putBuffer(key, buf);
  return { key, sha256: hash };
}

interface ZoneSpec {
  label: string;
  roomType: string;
  pano: string;
  unitLabel?: string;
  dims?: { w: number; d: number; h: number; camH: number };
  photoYaws?: number[];
  build3d?: boolean;
}

/** Captures a room "in the app": uploads the 360° pano and a few photos rendered from it. */
async function captureZones(
  lister: SessionUser,
  propertyId: string,
  unitsByLabel: Map<string, string>,
  specs: ZoneSpec[],
  geo: { lat: number; lng: number } | null,
) {
  const session = await startCaptureSession(lister, { propertyId, device: "Demo capture (seed)", lat: geo?.lat ?? null, lng: geo?.lng ?? null, inApp: !!geo, tier: "T1" });
  const out: { id: string; spec: ZoneSpec }[] = [];
  for (const s of specs) {
    const unitId = s.unitLabel ? unitsByLabel.get(s.unitLabel) ?? null : null;
    const z = await createZone(lister, propertyId, { label: s.label, roomType: s.roomType, unitId });
    if (s.dims) await updateZone(lister, z.id, { roomDims: s.dims });
    const panoBuf = await readFile(path.join(PANO_DIR, `${s.pano}.jpg`));
    await handleUpload(lister, { name: `${s.pano}.jpg`, bytes: panoBuf }, { propertyId, kind: "pano", unitId, zoneId: z.id, captureSessionId: geo ? session.id : null });
    const raw = await loadRaw(panoBuf, 2048);
    for (const yaw of s.photoYaws ?? [0, 2.2]) {
      const photo = await equirectToPerspective(raw, { yaw, pitch: -0.08, width: 1280, height: 960, hfovDeg: 78 });
      await handleUpload(lister, { name: `${s.pano}-${yaw}.jpg`, bytes: photo }, { propertyId, kind: "photo", unitId, zoneId: z.id, captureSessionId: geo ? session.id : null });
    }
    out.push({ id: z.id, spec: s });
  }
  return out;
}

async function unitMap(propertyId: string) {
  const { units } = await import("../src/server/schema");
  const rows = await db.select().from(units).where(eq(units.propertyId, propertyId));
  return new Map(rows.map((r) => [r.label, r.id]));
}

function plan(planKey: string, appliesTo: string, label: string, rent: number, chargesList: Parameters<typeof setPricePlan>[2]["charges"], extra: Partial<Parameters<typeof setPricePlan>[2]> = {}) {
  return { planKey, appliesTo: appliesTo as never, label, basePaise: rupeesToPaise(rent), period: "month" as const, charges: chargesList, ...extra };
}

const C = {
  deposit: (months: number) => ({ code: "security_deposit", mode: "months_of_rent" as const, months, recurrence: "one_time" as const, refundable: true, mandatory: true }),
  noBrokerage: { code: "brokerage", mode: "none" as const, recurrence: "one_time" as const, refundable: false, mandatory: true },
  brokerage: (months: number) => ({ code: "brokerage", mode: "months_of_rent" as const, months, recurrence: "one_time" as const, refundable: false, mandatory: true }),
  fixed: (code: string, rupees: number, recurrence: "one_time" | "monthly" | "nightly", refundable = false) => ({ code, mode: "fixed" as const, amountPaise: rupeesToPaise(rupees), recurrence, refundable, mandatory: true }),
  metered: (code: string, note: string) => ({ code, mode: "metered" as const, recurrence: "monthly" as const, note, refundable: false, mandatory: true }),
  included: (code: string) => ({ code, mode: "included" as const, recurrence: "monthly" as const, refundable: false, mandatory: true }),
  tax: (percent: number) => ({ code: "tax", mode: "percent" as const, percent, recurrence: "nightly" as const, refundable: false, mandatory: true, note: "GST as charged by the hotel" }),
};

async function main() {
  if (process.env.DEV_TOOLS !== "1") throw new Error("Run the seed with DEV_TOOLS=1 (see .env.local)");
  const [{ n: existing }] = await db.select({ n: sql<number>`count(*)::int` }).from(listings);
  if (existing > 0 && !process.argv.includes("--force")) {
    console.log("Database already has listings. Run `npm run db:reset` first (or pass --force).");
    return;
  }
  for (const l of LOCALITIES) await db.insert(localities).values({ ...l, city: "Delhi" }).onConflictDoNothing();
  log("localities", LOCALITIES.length);

  const admin = await user("+919000000009", "Nazariya Admin", ["renter", "admin"]);
  const renter = await user("+919000000001", "Aarav Sharma");
  const renter2 = await user("+919000000014", "Priya Nair");
  let rohit = await user("+919000000002", "Rohit Verma");
  let meera = await user("+919000000003", "Meera Joshi");
  let vikram = await user("+919000000004", "Vikram Arora");
  let sunita = await user("+919000000005", "Sunita Kapoor");
  let neha = await user("+919000000006", "Neha Singh");
  let mohit = await user("+919000000007", "Mohit K");
  let ankit = await user("+919000000011", "Ankit Yadav");

  await createOrganization(rohit, { type: "brokerage", displayName: "Rohit Estates", yourName: "Rohit Verma", localities: ["lajpat-nagar", "dwarka-sector-12"] });
  await createOrganization(meera, { type: "pg_operator", displayName: "Meera Stays", yourName: "Meera Joshi", localities: ["kamla-nagar"] });
  await createOrganization(vikram, { type: "hotel", displayName: "Karol Residency Hospitality", yourName: "Vikram Arora", localities: ["karol-bagh"] });
  await createOrganization(sunita, { type: "owner_individual", displayName: "Sunita Kapoor (owner)", yourName: "Sunita Kapoor", localities: ["saket"] });
  await createOrganization(neha, { type: "brokerage", displayName: "Capital Homes", yourName: "Neha Singh", localities: ["dwarka-sector-12"] });
  await createOrganization(mohit, { type: "brokerage", displayName: "Quick Rentals Delhi", yourName: "Mohit K", localities: ["laxmi-nagar"] });
  await createOrganization(ankit, { type: "pg_operator", displayName: "Scholars Stay", yourName: "Ankit Yadav", localities: ["mukherjee-nagar"] });
  [rohit, meera, vikram, sunita, neha, mohit, ankit] = await Promise.all([rohit, meera, vikram, sunita, neha, mohit, ankit].map(refresh));
  log("organisations created");

  // Identity checks through the sandbox KYC flows.
  for (const [u, pan, name] of [
    [rohit, "ABCPV1234K", "Rohit Verma"],
    [meera, "BCDPJ2345L", "Meera Joshi"],
    [vikram, "CDEPA3456M", "Vikram Arora"],
    [sunita, "DEFPK4567N", "Sunita Kapoor"],
    [neha, "EFGPS5678P", "Neha Singh"],
    [ankit, "FGHPY6789Q", "Ankit Yadav"],
  ] as const) {
    await verifyPan(u, pan, name);
  }
  for (const u of [rohit, meera, vikram, sunita, neha]) await verifyDigilocker(u, true);
  log("broker KYC (sandbox) done; Ankit has PAN only, Mohit has none");

  const today = todayIST();

  // ---------- 1. Sunrise Women's PG, Kamla Nagar ----------
  const pg1 = await createProperty(meera, {
    category: "pg",
    name: "Sunrise Women's PG",
    addressLine: "Plot 14, Bungalow Road, near Hansraj College",
    localityId: "kamla-nagar",
    pincode: "110007",
    lat: 28.6815,
    lng: 77.2051,
    floorsTotal: 3,
    amenities: ["wifi", "food", "laundry", "housekeeping", "power_backup", "cctv", "biometric", "ro_water", "geyser"],
    houseRules: { gender: "female", curfew: "22:30", visitors: "Common area only, till 8 pm", food: "Vegetarian meals (3 per day)", smoking: "Not allowed", alcohol: "Not allowed", noticeDays: 30, lockInMonths: 3 },
    owner: { name: "Harish Bansal", phone: "+919000000010", relationship: "landlord" },
    authorizationBasis: "operator_lease",
    units: [
      { kind: "pg_room", label: "Room 101 · Single", floor: 1, sharingCapacity: 1, ac: true, attachedBath: true, amenities: ["ac", "wardrobe", "study_table"] },
      { kind: "pg_room", label: "Room 102 · Double", floor: 1, sharingCapacity: 2, ac: true, attachedBath: true, amenities: ["ac", "wardrobe", "study_table"] },
      { kind: "pg_room", label: "Room 201 · Triple", floor: 2, sharingCapacity: 3, ac: false, attachedBath: false, amenities: ["wardrobe", "study_table"] },
    ],
  });
  const pg1Units = await unitMap(pg1.property.id);
  const pg1L = await createListing(meera, {
    propertyId: pg1.property.id,
    category: "pg",
    title: "Sunrise Women's PG near North Campus: AC rooms with meals",
    description:
      "Women-only PG a 6-minute walk from Vishwavidyalaya metro. Three vegetarian meals a day, daily housekeeping, biometric entry and a warden on site. Quiet study hours after 10 pm. Rooms on the first floor have attached bathrooms.",
    unitIds: [...pg1Units.values()],
    terms: { noticeDays: 30, lockInMonths: 3 },
  });
  const pgCharges = (elec: "metered" | "included") => [C.deposit(1), C.noBrokerage, C.fixed("admission_fee", 2000, "one_time"), elec === "metered" ? C.metered("electricity", "₹9/unit, sub-meter per room") : C.included("electricity"), C.included("food")];
  await setPricePlan(meera, pg1L.id, plan("bed_single", "bed_single", "Single sharing (AC)", 14500, pgCharges("metered"), { mealPlan: "3 veg meals/day" }));
  await setPricePlan(meera, pg1L.id, plan("bed_double", "bed_double", "Double sharing (AC)", 10500, pgCharges("metered"), { mealPlan: "3 veg meals/day" }));
  await setPricePlan(meera, pg1L.id, plan("bed_triple", "bed_triple", "Triple sharing", 8000, pgCharges("included"), { mealPlan: "3 veg meals/day" }));
  const pg1Zones = await captureZones(
    meera,
    pg1.property.id,
    pg1Units,
    [
      { label: "Room 102 · Double", roomType: "bedroom", pano: "pine_attic", unitLabel: "Room 102 · Double", dims: { w: 4.2, d: 5.0, h: 2.7, camH: 1.45 }, build3d: true },
      { label: "Room 101 · Single", roomType: "bedroom", pano: "small_empty_room_1", unitLabel: "Room 101 · Single", dims: { w: 3.4, d: 4.0, h: 2.8, camH: 1.5 } },
      { label: "Room 201 · Triple", roomType: "bedroom", pano: "small_empty_room_3", unitLabel: "Room 201 · Triple", dims: { w: 4.8, d: 5.5, h: 2.8, camH: 1.5 } },
      { label: "Dining & common area", roomType: "dining", pano: "comfy_cafe", dims: { w: 6, d: 7, h: 3.1, camH: 1.5 }, build3d: true },
      { label: "Washroom (2nd floor, shared)", roomType: "bathroom", pano: "bathroom", dims: { w: 2.4, d: 3.0, h: 2.7, camH: 1.5 }, photoYaws: [0] },
    ],
    { lat: 28.6815, lng: 77.2051 },
  );
  const pg1Beds = await db.select({ id: beds.id, label: beds.label, unitId: beds.unitId }).from(beds).where(sql`${beds.unitId} in (select id from units where property_id = ${pg1.property.id})`);
  const bedOf = (unitLabel: string, label: string) => pg1Beds.find((b) => b.unitId === pg1Units.get(unitLabel) && b.label === label)!.id;
  await setBedStatus(meera, bedOf("Room 102 · Double", "A"), { status: "occupied" });
  await setBedStatus(meera, bedOf("Room 102 · Double", "B"), { status: "notice", noticeUntil: addDays(today, 20) });
  await setBedStatus(meera, bedOf("Room 201 · Triple", "B"), { status: "occupied" });
  await setBedStatus(meera, bedOf("Room 201 · Triple", "C"), { status: "reserved", reservedUntil: addDays(today, 5) });
  log("PG Kamla Nagar drafted");

  // ---------- 2. Scholars Boys PG, Mukherjee Nagar (weaker trust signals; goes stale) ----------
  const pg2 = await createProperty(ankit, {
    category: "pg",
    name: "Scholars Boys PG",
    addressLine: "B-45, Comm. Complex, Dr. Mukherjee Nagar",
    localityId: "mukherjee-nagar",
    pincode: "110009",
    lat: 28.7071,
    lng: 77.2129,
    amenities: ["wifi", "food", "power_backup", "ro_water"],
    houseRules: { gender: "male", curfew: "23:00", food: "Veg & non-veg meals", smoking: "Not allowed", noticeDays: 15, lockInMonths: 1 },
    owner: { name: "Satish Gupta", phone: "+919000000015", relationship: "landlord" },
    authorizationBasis: "operator_lease",
    units: [{ kind: "pg_room", label: "Room 3 · Double", floor: 1, sharingCapacity: 2, ac: false, attachedBath: false }],
  });
  const pg2Units = await unitMap(pg2.property.id);
  const pg2L = await createListing(ankit, {
    propertyId: pg2.property.id,
    category: "pg",
    title: "Budget boys PG for UPSC aspirants, Mukherjee Nagar",
    description: "Walking distance to coaching institutes and GTB Nagar metro. Two meals a day, Wi-Fi and a reading room.",
    unitIds: [...pg2Units.values()],
  });
  await setPricePlan(ankit, pg2L.id, plan("bed_double", "bed_double", "Double sharing", 7500, [C.deposit(1), C.noBrokerage, C.included("electricity"), C.included("food")], { mealPlan: "2 meals/day" }));
  await captureZones(ankit, pg2.property.id, pg2Units, [{ label: "Room 3 · Double", roomType: "bedroom", pano: "lebombo", unitLabel: "Room 3 · Double", photoYaws: [0, 1.6, -1.6] }], { lat: 28.7071, lng: 77.2129 });
  log("PG Mukherjee Nagar drafted");

  // ---------- 3. 2BHK, Lajpat Nagar IV (Rohit, fully verified, 3D) ----------
  const flat1 = await createProperty(rohit, {
    category: "apartment",
    name: "Lajpat Nagar IV 2BHK",
    addressLine: "Flat 2B, Block C, Lajpat Nagar IV, near Central Market",
    localityId: "lajpat-nagar",
    pincode: "110024",
    lat: 28.5672,
    lng: 77.2441,
    floorsTotal: 4,
    amenities: ["power_backup", "parking", "ro_water"],
    houseRules: { tenantPreference: "Families and working professionals (owner's stated policy)", pets: "Small pets allowed", parking: "1 covered car park" },
    owner: { name: "Pradeep Malhotra", phone: "+919000000012", relationship: "owner" },
    authorizationBasis: "owner_mandate",
    units: [{ kind: "flat", label: "Flat 2B", floor: 2, bhk: 2, bathrooms: 2, balconies: 1, furnishing: "semi", declaredAreaSqft: 1050, amenities: ["wardrobe", "geyser", "modular_kitchen", "balcony"] }],
  });
  const flat1Units = await unitMap(flat1.property.id);
  const flat1L = await createListing(rohit, {
    propertyId: flat1.property.id,
    category: "rent",
    title: "Bright semi-furnished 2BHK near Lajpat Nagar Central Market",
    description: "Second-floor 2BHK with cross ventilation, modular kitchen, two bathrooms and a balcony facing a park. 8 minutes to Lajpat Nagar metro (Pink & Violet lines). Wardrobes in both bedrooms, geysers in both bathrooms.",
    unitIds: [...flat1Units.values()],
    terms: { minLeaseMonths: 11, lockInMonths: 6, noticeMonths: 1, agreement: "11-month registered agreement", escalation: "5% yearly" },
  });
  await setPricePlan(rohit, flat1L.id, plan("unit_monthly", "unit_monthly", "Whole flat", 38000, [C.deposit(2), C.brokerage(1), C.fixed("maintenance", 2000, "monthly"), C.metered("electricity", "BSES meter, ₹7–8/unit"), C.included("water")]));
  await setUnitAvailability(rohit, flat1Units.get("Flat 2B")!, { availableFrom: addDays(today, 7), minLeaseMonths: 11, status: "available" });
  const flat1Zones = await captureZones(
    rohit,
    flat1.property.id,
    flat1Units,
    [
      { label: "Living room", roomType: "living", pano: "cayley_interior", unitLabel: "Flat 2B", dims: { w: 5.5, d: 6.5, h: 3.0, camH: 1.5 }, build3d: true },
      { label: "Bedroom 1", roomType: "bedroom", pano: "lythwood_room", unitLabel: "Flat 2B", dims: { w: 4.0, d: 4.6, h: 2.9, camH: 1.5 }, build3d: true },
      { label: "Kitchen", roomType: "kitchen", pano: "kiara_interior", unitLabel: "Flat 2B", dims: { w: 4.5, d: 5.0, h: 2.9, camH: 1.5 } },
      { label: "Bathroom", roomType: "bathroom", pano: "modern_bathroom", unitLabel: "Flat 2B", dims: { w: 2.6, d: 3.2, h: 2.7, camH: 1.5 }, photoYaws: [0] },
    ],
    { lat: 28.5672, lng: 77.2441 },
  );
  log("2BHK Lajpat Nagar drafted");

  // ---------- 4. 1BHK, Saket (owner listing, no brokerage) ----------
  const flat2 = await createProperty(sunita, {
    category: "apartment",
    name: "Saket 1BHK",
    addressLine: "J-12, Saket, near Malviya Nagar metro",
    localityId: "saket",
    pincode: "110017",
    lat: 28.5262,
    lng: 77.2079,
    floorsTotal: 3,
    amenities: ["power_backup", "lift"],
    houseRules: { tenantPreference: "Working professionals (owner's stated policy)", pets: "No pets" },
    owner: { name: "Sunita Kapoor", phone: "+919000000005", relationship: "owner" },
    authorizationBasis: "owner_self",
    units: [{ kind: "flat", label: "Second floor 1BHK", floor: 2, bhk: 1, bathrooms: 1, balconies: 1, furnishing: "full", declaredAreaSqft: 620, amenities: ["ac", "fridge", "washing_machine", "wardrobe", "geyser", "balcony"] }],
  });
  const flat2Units = await unitMap(flat2.property.id);
  const flat2L = await createListing(sunita, {
    propertyId: flat2.property.id,
    category: "rent",
    title: "Fully furnished 1BHK with balcony, listed by owner, Saket",
    description: "Owner-managed, fully furnished 1BHK with AC, fridge and washing machine. Sunny balcony, quiet lane, 10 minutes' walk to Malviya Nagar metro and Select Citywalk.",
    unitIds: [...flat2Units.values()],
    terms: { minLeaseMonths: 11, lockInMonths: 3, noticeMonths: 1 },
  });
  await setPricePlan(sunita, flat2L.id, plan("unit_monthly", "unit_monthly", "Whole flat", 24000, [C.deposit(2), C.noBrokerage, C.included("maintenance"), C.metered("electricity", "₹8/unit")]));
  await setUnitAvailability(sunita, flat2Units.get("Second floor 1BHK")!, { availableFrom: today, minLeaseMonths: 11, status: "available" });
  await captureZones(
    sunita,
    flat2.property.id,
    flat2Units,
    [
      { label: "Living & bedroom", roomType: "living", pano: "reading_room", unitLabel: "Second floor 1BHK", dims: { w: 4.6, d: 5.2, h: 3.0, camH: 1.5 }, build3d: true },
      { label: "Balcony", roomType: "balcony", pano: "veranda", unitLabel: "Second floor 1BHK", dims: { w: 3.0, d: 4.0, h: 3.0, camH: 1.5 } },
    ],
    { lat: 28.5262, lng: 77.2079 },
  );
  log("1BHK Saket drafted");

  // ---------- 5. 3BHK, Dwarka Sector 12 (two authorised brokers, one property) ----------
  const flat3 = await createProperty(neha, {
    category: "apartment",
    name: "Dwarka Sector 12 3BHK",
    addressLine: "Flat 704, Shree Apartments, Plot 9, Sector 12, Dwarka",
    localityId: "dwarka-sector-12",
    pincode: "110078",
    lat: 28.5928,
    lng: 77.0441,
    floorsTotal: 8,
    amenities: ["lift", "parking", "power_backup", "guard", "cctv", "gym"],
    houseRules: { tenantPreference: "Families (owner's stated policy)", pets: "Allowed" },
    owner: { name: "Rajesh Gupta", phone: "+919000000008", relationship: "owner" },
    authorizationBasis: "owner_mandate",
    units: [{ kind: "flat", label: "Flat 704", floor: 7, bhk: 3, bathrooms: 2, balconies: 2, furnishing: "semi", declaredAreaSqft: 1450, amenities: ["wardrobe", "modular_kitchen", "geyser", "balcony"] }],
  });
  const flat3Units = await unitMap(flat3.property.id);
  // A second, non-exclusive authorisation for Rohit on the same property (multi-broker case).
  const { propertyAuthorizations } = await import("../src/server/schema");
  const [rohitAuth] = await db
    .insert(propertyAuthorizations)
    .values({ propertyId: flat3.property.id, orgId: rohit.orgs[0].id, basis: "owner_mandate", exclusive: false, validFrom: today, ownerContactId: (await db.execute(sql`select owner_contact_id from property_authorizations where id = ${flat3.authorizationId}`))[0].owner_contact_id as string })
    .returning();
  await db.transaction((tx) => writeAudit(tx, { actorUserId: rohit.id, actorRole: "lister", action: "authorization.requested", subjectType: "authorization", subjectId: rohitAuth.id }));
  await captureZones(
    neha,
    flat3.property.id,
    flat3Units,
    [
      { label: "Living room", roomType: "living", pano: "photo_studio_loft_hall", unitLabel: "Flat 704", dims: { w: 6, d: 7, h: 3.2, camH: 1.5 } },
      { label: "Master bedroom", roomType: "bedroom", pano: "brown_photostudio_04", unitLabel: "Flat 704", dims: { w: 4.5, d: 5, h: 3, camH: 1.5 } },
      { label: "Bedroom 2", roomType: "bedroom", pano: "photo_studio_london_hall", unitLabel: "Flat 704", dims: { w: 4.2, d: 4.8, h: 3.2, camH: 1.5 } },
    ],
    { lat: 28.5928, lng: 77.0441 },
  );
  const dwDesc = "Seventh-floor 3BHK in a gated society with lift, power backup, gym and covered parking. 5 minutes to Dwarka Sector 12 metro (Blue line).";
  const flat3L = await createListing(neha, { propertyId: flat3.property.id, category: "rent", title: "Spacious 3BHK in gated society, Dwarka Sector 12", description: dwDesc, unitIds: [...flat3Units.values()], terms: { minLeaseMonths: 11, noticeMonths: 1 } });
  await setPricePlan(neha, flat3L.id, plan("unit_monthly", "unit_monthly", "Whole flat", 32000, [C.deposit(2), C.brokerage(1), C.fixed("maintenance", 3500, "monthly"), C.metered("electricity", "₹7/unit")]));
  await setUnitAvailability(neha, flat3Units.get("Flat 704")!, { availableFrom: addDays(today, 14), minLeaseMonths: 11, status: "available" });
  rohit = await refresh(rohit);
  const flat3L2 = await createListing(rohit, { propertyId: flat3.property.id, category: "rent", title: "3BHK with two balconies near Dwarka Sec 12 metro", description: dwDesc, unitIds: [...flat3Units.values()], terms: { minLeaseMonths: 11, noticeMonths: 1 } });
  await setPricePlan(rohit, flat3L2.id, plan("unit_monthly", "unit_monthly", "Whole flat", 32000, [C.deposit(2), C.brokerage(0.5), C.fixed("maintenance", 3500, "monthly"), C.metered("electricity", "₹7/unit")]));
  log("3BHK Dwarka drafted (2 brokers)");

  // ---------- 6. Hotel Karol Residency, Karol Bagh ----------
  const hotel = await createProperty(vikram, {
    category: "hotel",
    name: "Hotel Karol Residency",
    addressLine: "16/7 Arya Samaj Road, Karol Bagh",
    localityId: "karol-bagh",
    pincode: "110005",
    lat: 28.6524,
    lng: 77.1902,
    floorsTotal: 5,
    amenities: ["wifi", "ac", "power_backup", "lift", "room_service", "restaurant", "cctv"],
    houseRules: { checkIn: "12:00", checkOut: "11:00", idPolicy: "Government photo ID for every adult guest", couples: "Married and unmarried couples welcome with valid ID", cancellation: "Free cancellation up to 24 hours before check-in" },
    owner: { name: "Karan Arora", phone: "+919000000013", relationship: "owner" },
    authorizationBasis: "hotel_management",
    units: [
      { kind: "hotel_room_type", label: "Deluxe Double", maxOccupancy: 2, inventoryCount: 6, declaredAreaSqft: 180, ac: true, attachedBath: true, amenities: ["ac", "tv", "wifi", "geyser"] },
      { kind: "hotel_room_type", label: "Executive Family", maxOccupancy: 3, inventoryCount: 3, declaredAreaSqft: 260, ac: true, attachedBath: true, amenities: ["ac", "tv", "wifi", "fridge", "geyser"] },
    ],
  });
  const hotelUnits = await unitMap(hotel.property.id);
  const hotelL = await createListing(vikram, {
    propertyId: hotel.property.id,
    category: "short_stay",
    title: "Hotel Karol Residency: walk to Karol Bagh metro & market",
    description: "Family-run hotel 4 minutes from Karol Bagh metro and Ajmal Khan Road market. Lift, 24-hour reception, in-house vegetarian restaurant and room service.",
    unitIds: [...hotelUnits.values()],
    terms: { checkIn: "12:00", checkOut: "11:00", cancellation: "Free cancellation up to 24 hours before check-in" },
  });
  const deluxe = hotelUnits.get("Deluxe Double")!;
  const exec = hotelUnits.get("Executive Family")!;
  await setPricePlan(vikram, hotelL.id, { planKey: `rt:${deluxe}`, unitId: deluxe, appliesTo: "room_type_nightly", label: "Deluxe Double", basePaise: rupeesToPaise(2800), period: "night", mealPlan: "Breakfast included", charges: [C.tax(5), { ...C.fixed("extra_bed", 700, "nightly"), mandatory: false }] });
  await setPricePlan(vikram, hotelL.id, { planKey: `rt:${exec}`, unitId: exec, appliesTo: "room_type_nightly", label: "Executive Family", basePaise: rupeesToPaise(4200), period: "night", mealPlan: "Breakfast included", charges: [C.tax(5)] });
  await setNightlyInventory(vikram, deluxe, { from: today, to: addDays(today, 60), availableCount: 4, ratePaise: rupeesToPaise(2800) });
  await setNightlyInventory(vikram, deluxe, { from: addDays(today, 10), to: addDays(today, 11), availableCount: 0, ratePaise: rupeesToPaise(3200) });
  await setNightlyInventory(vikram, exec, { from: today, to: addDays(today, 60), availableCount: 2, ratePaise: rupeesToPaise(4200) });
  await captureZones(
    vikram,
    hotel.property.id,
    hotelUnits,
    [
      { label: "Deluxe Double (representative room)", roomType: "room", pano: "hotel_room", unitLabel: "Deluxe Double", dims: { w: 3.8, d: 4.6, h: 2.8, camH: 1.5 }, build3d: true },
      { label: "Executive Family (representative room)", roomType: "room", pano: "brown_photostudio_07", unitLabel: "Executive Family", dims: { w: 4.6, d: 5.6, h: 3.0, camH: 1.5 } },
    ],
    { lat: 28.6524, lng: 77.1902 },
  );
  log("Hotel Karol Bagh drafted");

  // ---------- 7. Suspicious listing (stolen photos at a different address) ----------
  const fake = await createProperty(mohit, {
    category: "apartment",
    addressLine: "Near Laxmi Nagar metro, Vikas Marg",
    localityId: "laxmi-nagar",
    pincode: "110092",
    amenities: [],
    houseRules: {},
    owner: { name: "Owner", phone: "+919000000016", relationship: "owner" },
    authorizationBasis: "owner_mandate",
    units: [{ kind: "flat", label: "2BHK", bhk: 2, bathrooms: 2, furnishing: "semi" }],
  });
  const fakeUnits = await unitMap(fake.property.id);
  const fakeL = await createListing(mohit, { propertyId: fake.property.id, category: "rent", title: "Cheap 2BHK semi furnished near Laxmi Nagar metro", description: "Immediate shifting. Call now for visit.", unitIds: [...fakeUnits.values()] });
  await setPricePlan(mohit, fakeL.id, plan("unit_monthly", "unit_monthly", "Whole flat", 16000, [C.deposit(1), C.brokerage(1)]));
  await setUnitAvailability(mohit, fakeUnits.get("2BHK")!, { availableFrom: today, status: "available" });
  // Re-uploads copies of the Lajpat Nagar photos from the gallery (no in-app capture session).
  const lajpatPano = await loadRaw(await readFile(path.join(PANO_DIR, "cayley_interior.jpg")), 2048);
  const lajpatBed = await loadRaw(await readFile(path.join(PANO_DIR, "lythwood_room.jpg")), 2048);
  for (const [img, yaw] of [[lajpatPano, 0], [lajpatPano, 2.2], [lajpatBed, 0], [lajpatBed, 2.2]] as const) {
    const photo = await equirectToPerspective(img, { yaw, pitch: -0.08, width: 1280, height: 960, hfovDeg: 78 });
    const reencoded = await sharp(photo).resize(1200).jpeg({ quality: 70 }).toBuffer();
    await handleUpload(mohit, { name: "IMG_2041.jpg", bytes: reencoded }, { propertyId: fake.property.id, kind: "photo", unitId: fakeUnits.get("2BHK") });
  }
  log("suspicious listing drafted");

  await drain("media processing");

  // 3D walkthroughs for selected rooms.
  const want3d = [...pg1Zones, ...flat1Zones].filter((z) => z.spec.build3d);
  for (const z of want3d) await requestSplatBuild(z.spec.unitLabel?.startsWith("Room") ? meera : z.spec.label.includes("Dining") ? meera : rohit, z.id);
  const others3d = await db.select().from(zones).where(sql`${zones.label} in ('Living & bedroom', 'Deluxe Double (representative room)')`);
  for (const z of others3d) await requestSplatBuild(z.label.startsWith("Living") ? sunita : vikram, z.id);
  await drain("3D scene builds");

  // Hotspots.
  const zoneByLabel = async (propertyId: string, label: string) =>
    (await db.select().from(zones).where(sql`${zones.label} = ${label} and ${zones.tourId} in (select id from tours where property_id = ${propertyId})`))[0];
  const z102 = await zoneByLabel(pg1.property.id, "Room 102 · Double");
  const zDining = await zoneByLabel(pg1.property.id, "Dining & common area");
  const zWash = await zoneByLabel(pg1.property.id, "Washroom (2nd floor, shared)");
  await addHotspot(meera, z102.id, { type: "amenity", yaw: 0.9, pitch: 0.25, title: "Split AC (1.5 ton)", body: "Serviced every summer. Electricity on the room sub-meter." });
  await addHotspot(meera, z102.id, { type: "amenity", yaw: -1.2, pitch: -0.15, title: "Study tables ×2", body: "One table and chair per resident, with reading lamp." });
  await addHotspot(meera, z102.id, { type: "door_to_zone", yaw: 2.9, pitch: -0.05, title: "Go to dining area", body: "", targetZoneId: zDining.id });
  await addHotspot(meera, zDining.id, { type: "info", yaw: 0.3, pitch: 0, title: "Meal timings", body: "Breakfast 7:30–9:30 · Lunch 1–2:30 · Dinner 8–9:30. Vegetarian menu changes weekly." });
  await addHotspot(meera, zDining.id, { type: "door_to_zone", yaw: -2.6, pitch: -0.05, title: "Back to Room 102", body: "", targetZoneId: z102.id });
  await addHotspot(meera, zWash.id, { type: "amenity", yaw: 0.4, pitch: 0.1, title: "Geyser", body: "Instant geyser, cleaned daily." });
  const zLiving = await zoneByLabel(flat1.property.id, "Living room");
  const zBed1 = await zoneByLabel(flat1.property.id, "Bedroom 1");
  const zKitchen = await zoneByLabel(flat1.property.id, "Kitchen");
  const zBath = await zoneByLabel(flat1.property.id, "Bathroom");
  await addHotspot(rohit, zLiving.id, { type: "view", yaw: 0.2, pitch: 0.05, title: "Park-facing windows", body: "Morning sun; the balcony overlooks the block park." });
  await addHotspot(rohit, zLiving.id, { type: "door_to_zone", yaw: 1.8, pitch: -0.05, title: "Bedroom 1", body: "", targetZoneId: zBed1.id });
  await addHotspot(rohit, zLiving.id, { type: "door_to_zone", yaw: -1.9, pitch: -0.05, title: "Kitchen", body: "", targetZoneId: zKitchen.id });
  await addHotspot(rohit, zBed1.id, { type: "amenity", yaw: -1.5, pitch: 0.05, title: "Built-in wardrobe", body: "Floor-to-ceiling, 3 doors." });
  await addHotspot(rohit, zBed1.id, { type: "door_to_zone", yaw: 3.0, pitch: -0.05, title: "Back to living room", body: "", targetZoneId: zLiving.id });
  await addHotspot(rohit, zKitchen.id, { type: "amenity", yaw: 0.6, pitch: -0.2, title: "Modular kitchen", body: "Chimney and RO purifier stay with the flat." });
  await addHotspot(rohit, zBath.id, { type: "issue_disclosure", yaw: 0.8, pitch: 0.6, title: "Past seepage (repaired)", body: "Minor ceiling seepage was repaired and repainted in August 2026." });
  log("hotspots added");

  // Owner confirmations (via the real OTP flow) and document reviews.
  await confirmOwner(meera, pg1.authorizationId);
  await confirmOwner(ankit, pg2.authorizationId);
  await confirmOwner(rohit, flat1.authorizationId);
  await confirmOwner(neha, flat3.authorizationId);
  await confirmOwner(rohit, rohitAuth.id);
  await confirmOwner(vikram, hotel.authorizationId);
  await confirmOwner(mohit, fake.authorizationId); // "owner" phone is the fraudster's second number
  const docChecks = [
    await submitAuthorizationDocument(meera, pg1.authorizationId, "operator_lease", await demoDocument("Lease agreement: Meera Stays")),
    await submitAuthorizationDocument(rohit, flat1.authorizationId, "ownership_document", await demoDocument("Property tax receipt: P. Malhotra")),
    await submitAuthorizationDocument(sunita, flat2.authorizationId, "ownership_document", await demoDocument("Electricity bill: S. Kapoor")),
    await submitAuthorizationDocument(neha, flat3.authorizationId, "ownership_document", await demoDocument("Sale deed (first page): R. Gupta")),
    await submitAuthorizationDocument(vikram, hotel.authorizationId, "hotel_registration", await demoDocument("Trade licence: Hotel Karol Residency")),
  ];
  for (const c of docChecks) await decideCheck(admin, c.id, "passed", "Name and address match the property record (demo review)");
  await submitAuthorizationDocument(rohit, rohitAuth.id, "ownership_document", await demoDocument("Owner mandate letter: R. Gupta to Rohit Estates"));
  log("owner confirmations and document reviews done (Rohit's Dwarka document left for admin review)");

  for (const [u, l] of [
    [meera, pg1L],
    [ankit, pg2L],
    [rohit, flat1L],
    [sunita, flat2L],
    [neha, flat3L],
    [rohit, flat3L2],
    [vikram, hotelL],
    [mohit, fakeL],
  ] as const) {
    await publishListing(u, l.id);
  }
  await drain("on-site checks");
  for (const p of [fake.property.id, flat1.property.id]) await runDedupeForProperty(p);
  log("listings published; duplicate detection run");

  // Demo shortcut: back-date Scholars PG's last confirmation to show the stale state.
  await db.update(listings).set({ lastConfirmedAt: new Date(Date.now() - 9 * 86400_000) }).where(eq(listings.id, pg2L.id));
  await freshnessSweep();

  // Engagement.
  const e1 = await createEnquiry(renter, { listingId: pg1L.id, planKey: "bed_double", moveInDate: addDays(today, 21), guests: 1, message: "Hi, I'm joining DU in November. Is the double-sharing bed available from the 21st? Can I visit this weekend?" });
  const slot = (d: number, h: number) => {
    const x = new Date(addDays(today, d) + "T00:00:00+05:30");
    x.setHours(x.getHours() + h);
    return x.toISOString();
  };
  await proposeVisits(meera, e1.id, [
    { start: slot(2, 11), mode: "in_person" },
    { start: slot(3, 17), mode: "video" },
  ]);
  const { visits } = await import("../src/server/schema");
  const [firstVisit] = await db.select().from(visits).where(eq(visits.enquiryId, e1.id)).orderBy(visits.slotStart);
  await updateVisit(renter, firstVisit.id, "confirmed");
  await createEnquiry(renter, { listingId: flat1L.id, planKey: "unit_monthly", moveInDate: addDays(today, 10), guests: 2, message: "We are a couple working in Nehru Place. Is the 2BHK available from next week?" });
  await createBookingRequest(renter2, { listingId: hotelL.id, unitId: deluxe, from: addDays(today, 3), to: addDays(today, 5), guests: 2 });
  await createReport(renter2, fakeL.id, "fake_photos", "These photos look exactly like a Lajpat Nagar flat I saw on Nazariya.");
  await deliverNotifications(() => {});
  log("enquiries, visit, booking request and a report created");

  console.log("\nSeed complete. Log in with any demo phone; OTPs appear at /dev/outbox.");
  console.log("  Renter +91 9000000001 · Broker +91 9000000002 · PG operator +91 9000000003 · Hotel +91 9000000004 · Admin +91 9000000009");
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
