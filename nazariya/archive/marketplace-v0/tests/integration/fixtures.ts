import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { addDays, todayIST } from "@/lib/availability";
import { loadSessionUser, type SessionUser } from "@/server/auth";
import { db } from "@/server/db";
import { claimJobs, completeJob, failJob } from "@/server/jobs";
import * as L from "@/server/listings";
import { handleUpload, startCaptureSession } from "@/server/media";
import { handleJob } from "@/server/pipeline/process";
import { localities, users } from "@/server/schema";
import { addCheck, ownerRespond, requestOwnerConfirmation, sendOwnerOtp } from "@/server/trust";

export const today = todayIST();
export { addDays };

export function randomPhone() {
  return `+919${String(randomInt(0, 1e9)).padStart(9, "0")}`;
}

export async function ensureLocalities() {
  await db
    .insert(localities)
    .values([
      { id: "lajpat-nagar", name: "Lajpat Nagar", lat: 28.5677, lng: 77.2433, nearestMetro: "Lajpat Nagar" },
      { id: "laxmi-nagar", name: "Laxmi Nagar", lat: 28.6304, lng: 77.2773, nearestMetro: "Laxmi Nagar" },
      { id: "kamla-nagar", name: "Kamla Nagar", lat: 28.6812, lng: 77.2045, nearestMetro: "Vishwavidyalaya" },
      { id: "karol-bagh", name: "Karol Bagh", lat: 28.6519, lng: 77.1909, nearestMetro: "Karol Bagh" },
    ])
    .onConflictDoNothing();
}

export async function makeUser(name = "Test User", roles: string[] = ["renter"]): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ phone: randomPhone(), name, roles }).returning();
  await db.transaction((tx) => addCheck(tx, { subjectType: "user", subjectId: u.id, checkType: "phone_otp", status: "passed", method: "automated" }));
  return (await loadSessionUser(u.id))!;
}

export async function makeLister(type: "brokerage" | "pg_operator" | "hotel" | "owner_individual" = "brokerage") {
  const u = await makeUser("Lister " + randomInt(0, 1e6));
  await L.createOrganization(u, { type, displayName: `Org ${randomInt(0, 1e6)}`, yourName: u.name ?? "Lister" });
  return (await loadSessionUser(u.id))!;
}

export async function makeAdmin() {
  return makeUser("Admin", ["renter", "admin"]);
}

/** Seed-specific test image: a coarse random colour grid (distinct perceptual hash per seed)
 *  plus fine noise so it passes the blur gate. Same seed → identical image. */
export async function noiseJpeg(width: number, height: number, seed = 1) {
  let x = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x / 0x7fffffff);
  const gw = 12;
  const gh = 9;
  const grid = Array.from({ length: gw * gh }, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
  const buf = Buffer.alloc(width * height * 3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const cell = grid[Math.floor((j / height) * gh) * gw + Math.floor((i / width) * gw)];
      for (let c = 0; c < 3; c++) buf[(j * width + i) * 3 + c] = Math.max(0, Math.min(255, cell[c] + (rnd() - 0.5) * 50));
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

export async function drainJobs() {
  for (let i = 0; i < 200; i++) {
    const jobs = await claimJobs("test", 5);
    if (!jobs.length) return;
    for (const j of jobs) {
      try {
        await completeJob(j.id, await handleJob(j));
      } catch (e) {
        await failJob(j, e);
      }
    }
  }
}

export async function confirmOwner(lister: SessionUser, authorizationId: string, accept = true) {
  await requestOwnerConfirmation(lister, authorizationId);
  const { devCode } = await sendOwnerOtp(authorizationId);
  await ownerRespond(authorizationId, devCode!, accept);
}

/** A complete, publishable flat listing (owner confirmed, priced, 3 photos, availability). */
export async function makeFlatListing(opts: { lister?: SessionUser; locality?: string; lat?: number; lng?: number; address?: string; brokerageMonths?: number | null; photoSeed?: number; confirm?: boolean } = {}) {
  await ensureLocalities();
  const lister = opts.lister ?? (await makeLister());
  const { property, authorizationId } = await L.createProperty(lister, {
    category: "apartment",
    addressLine: opts.address ?? `Flat ${randomInt(1, 999)}, Block C, Lajpat Nagar IV`,
    localityId: opts.locality ?? "lajpat-nagar",
    lat: opts.lat ?? 28.5672,
    lng: opts.lng ?? 77.2441,
    amenities: [],
    houseRules: {},
    owner: { name: "Owner", phone: randomPhone(), relationship: "owner" },
    authorizationBasis: "owner_mandate",
    units: [{ kind: "flat", label: "Flat", bhk: 2, bathrooms: 2, furnishing: "semi", amenities: [] }],
  });
  const units = await db.query.units.findMany({ where: (u, { eq: e }) => e(u.propertyId, property.id) });
  const listing = await L.createListing(lister, {
    propertyId: property.id,
    category: "rent",
    title: "Test flat listing for integration",
    description: "Two bedrooms, near the metro.",
    unitIds: units.map((u) => u.id),
  });
  await L.setPricePlan(lister, listing.id, {
    planKey: "unit_monthly",
    appliesTo: "unit_monthly",
    label: "Whole flat",
    basePaise: 3_000_000,
    period: "month",
    charges: [
      { code: "security_deposit", mode: "months_of_rent", months: 2, recurrence: "one_time", refundable: true },
      opts.brokerageMonths ? { code: "brokerage", mode: "months_of_rent", months: opts.brokerageMonths, recurrence: "one_time" } : { code: "brokerage", mode: "none", recurrence: "one_time" },
    ],
  });
  await L.setUnitAvailability(lister, units[0].id, { availableFrom: today, minLeaseMonths: 11, status: "available" });
  const session = await startCaptureSession(lister, { propertyId: property.id, lat: opts.lat ?? 28.5672, lng: opts.lng ?? 77.2441, inApp: true });
  for (let i = 0; i < 3; i++) {
    await handleUpload(lister, { name: `p${i}.jpg`, bytes: await noiseJpeg(800, 600, (opts.photoSeed ?? randomInt(1, 1e6)) + i) }, { propertyId: property.id, kind: "photo", unitId: units[0].id, captureSessionId: session.id });
  }
  await drainJobs();
  if (opts.confirm !== false) await confirmOwner(lister, authorizationId);
  return { lister, property, authorizationId, listing, unit: units[0] };
}

export async function reloadListing(id: string) {
  const { listings } = await import("@/server/schema");
  const [l] = await db.select().from(listings).where(eq(listings.id, id));
  return l;
}
