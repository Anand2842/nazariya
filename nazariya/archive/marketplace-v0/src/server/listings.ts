// Listings module: properties, units, listings, versioned pricing, availability, tours, publishing.
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { pgAvailability, todayIST, type RoomBeds } from "@/lib/availability";
import { normalizeAddress } from "@/lib/dedupe";
import { freshnessState, type ListingCategory } from "@/lib/freshness";
import { moderateText } from "@/lib/moderation";
import { positionFromYawPitch, validateRoomDims, type RoomDims } from "@/lib/pano-geometry";
import { computeCostSummary, disclosureErrors, type ChargeInput, type PlanInput } from "@/lib/pricing";
import { writeAudit } from "./audit";
import { normalizePhone, type SessionUser } from "./auth";
import { db, type Exec } from "./db";
import { DomainError, shortId, slugify } from "./errors";
import { enqueue } from "./jobs";
import {
  availability,
  beds,
  charges,
  hotspots,
  listings,
  listingUnits,
  localities,
  mediaAssets,
  nightlyInventory,
  organizations,
  ownerContacts,
  pricePlans,
  properties,
  propertyAuthorizations,
  tours,
  units,
  users,
  zones,
} from "./schema";
import { publicUrl } from "./storage";
import { addCheck, badgesForListing, badgesForListings, runOnsiteCheck } from "./trust";

// ---------- access helpers ----------

export function requireOrg(user: SessionUser, orgId?: string) {
  const org = orgId ? user.orgs.find((o) => o.id === orgId) : user.orgs[0];
  if (!org) throw new DomainError("Create your lister profile first", "forbidden");
  return org;
}

export async function loadListingForOrg(user: SessionUser, listingId: string, exec: Exec = db) {
  const [l] = await exec.select().from(listings).where(eq(listings.id, listingId));
  if (!l) throw new DomainError("Listing not found", "not_found");
  if (!user.orgs.some((o) => o.id === l.orgId) && !user.roles.includes("admin")) throw new DomainError("Not your listing", "forbidden");
  return l;
}

async function loadPropertyForOrg(user: SessionUser, propertyId: string, exec: Exec = db) {
  const [p] = await exec.select().from(properties).where(eq(properties.id, propertyId));
  if (!p) throw new DomainError("Property not found", "not_found");
  const auths = await exec.select().from(propertyAuthorizations).where(eq(propertyAuthorizations.propertyId, propertyId));
  const orgIds = new Set([p.createdByOrgId, ...auths.filter((a) => a.status !== "revoked" && a.status !== "rejected").map((a) => a.orgId)]);
  if (![...orgIds].some((id) => user.orgs.some((o) => o.id === id)) && !user.roles.includes("admin")) throw new DomainError("Not your property", "forbidden");
  return p;
}

// ---------- organisation onboarding ----------

export const orgSchema = z.object({
  type: z.enum(["brokerage", "pg_operator", "property_manager", "hotel", "owner_individual"]),
  displayName: z.string().trim().min(2).max(80),
  yourName: z.string().trim().min(2).max(80),
  localities: z.array(z.string()).max(20).default([]),
});

export async function createOrganization(user: SessionUser, input: z.input<typeof orgSchema>) {
  const v = orgSchema.parse(input);
  const mod = moderateText(v.displayName);
  if (!mod.ok) throw new DomainError("Please change the name", "invalid", mod.errors);
  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ type: v.type, displayName: v.displayName }).returning();
    await tx.insert((await import("./schema")).memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    const roles = Array.from(new Set([...user.roles, "lister"]));
    await tx.update(users).set({ roles, name: v.yourName }).where(eq(users.id, user.id));
    await tx
      .insert((await import("./schema")).brokerProfiles)
      .values({ userId: user.id, displayName: v.yourName, localities: v.localities, activeSince: todayIST() })
      .onConflictDoNothing();
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "org.created", subjectType: "organization", subjectId: org.id, data: { type: v.type } });
    return org;
  });
}

// ---------- properties & units ----------

const unitSchema = z.object({
  kind: z.enum(["flat", "house", "pg_room", "hotel_room_type", "room_in_flat"]),
  label: z.string().trim().min(1).max(60),
  floor: z.coerce.number().int().min(-2).max(80).optional().nullable(),
  bhk: z.coerce.number().int().min(0).max(10).optional().nullable(),
  bathrooms: z.coerce.number().int().min(0).max(10).optional().nullable(),
  balconies: z.coerce.number().int().min(0).max(10).optional().nullable(),
  attachedBath: z.boolean().optional().nullable(),
  ac: z.boolean().optional().nullable(),
  furnishing: z.enum(["unfurnished", "semi", "full"]).optional().nullable(),
  sharingCapacity: z.coerce.number().int().min(1).max(8).optional().nullable(),
  maxOccupancy: z.coerce.number().int().min(1).max(10).optional().nullable(),
  inventoryCount: z.coerce.number().int().min(1).max(500).optional().nullable(),
  declaredAreaSqft: z.coerce.number().int().min(20).max(20000).optional().nullable(),
  amenities: z.array(z.string()).default([]),
});

export const propertySchema = z.object({
  category: z.enum(["pg", "apartment", "house", "hotel", "guesthouse"]),
  name: z.string().trim().max(100).optional().nullable(),
  addressLine: z.string().trim().min(5).max(200),
  localityId: z.string().min(1),
  pincode: z.string().regex(/^1[1-2]\d{4}$/, "Delhi pincodes start with 11 or 12").optional().nullable(),
  lat: z.coerce.number().min(28.3).max(28.95).optional().nullable(),
  lng: z.coerce.number().min(76.8).max(77.5).optional().nullable(),
  floorsTotal: z.coerce.number().int().min(1).max(80).optional().nullable(),
  amenities: z.array(z.string()).default([]),
  houseRules: z.record(z.string(), z.unknown()).default({}),
  owner: z.object({ name: z.string().trim().min(2).max(80), phone: z.string(), relationship: z.string().default("owner") }),
  authorizationBasis: z.enum(["owner_self", "owner_mandate", "operator_lease", "hotel_management"]),
  exclusive: z.boolean().default(false),
  units: z.array(unitSchema).min(1).max(60),
});

export async function createProperty(user: SessionUser, input: z.input<typeof propertySchema>, orgId?: string) {
  const org = requireOrg(user, orgId);
  const v = propertySchema.parse(input);
  const [loc] = await db.select().from(localities).where(eq(localities.id, v.localityId));
  if (!loc) throw new DomainError("Unknown locality");
  const ownerPhone = normalizePhone(v.owner.phone);
  const lat = v.lat ?? loc.lat;
  const lng = v.lng ?? loc.lng;
  const result = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(properties)
      .values({
        category: v.category,
        name: v.name ?? null,
        addressLine: v.addressLine,
        localityId: v.localityId,
        pincode: v.pincode ?? null,
        lat,
        lng,
        normalizedAddress: normalizeAddress(`${v.addressLine} ${loc.name}`),
        floorsTotal: v.floorsTotal ?? null,
        amenities: v.amenities,
        houseRules: v.houseRules,
        createdByOrgId: org.id,
      })
      .returning();
    const [owner] = await tx
      .insert(ownerContacts)
      .values({ propertyId: p.id, name: v.owner.name, phone: ownerPhone, relationship: v.owner.relationship })
      .returning();
    const [auth] = await tx
      .insert(propertyAuthorizations)
      .values({
        propertyId: p.id,
        orgId: org.id,
        basis: v.authorizationBasis,
        exclusive: v.exclusive,
        validFrom: todayIST(),
        validUntil: null,
        ownerContactId: owner.id,
      })
      .returning();
    let sort = 0;
    for (const u of v.units) {
      const [unit] = await tx
        .insert(units)
        .values({ ...u, propertyId: p.id, sort: sort++, attachedBath: u.attachedBath ?? null, ac: u.ac ?? null })
        .returning();
      if (u.kind === "pg_room") {
        const n = u.sharingCapacity ?? 1;
        for (let i = 0; i < n; i++) await tx.insert(beds).values({ unitId: unit.id, label: String.fromCharCode(65 + i) });
      }
    }
    await tx.insert(tours).values({ propertyId: p.id });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "property.created", subjectType: "property", subjectId: p.id, data: { orgId: org.id, basis: v.authorizationBasis } });
    // Owner listing their own property with the same verified phone: confirmation is implicit.
    if (v.authorizationBasis === "owner_self" && ownerPhone === user.phone) {
      await addCheck(tx, {
        subjectType: "authorization",
        subjectId: auth.id,
        checkType: "owner_contact_confirmation",
        status: "passed",
        method: "automated",
        data: { via: "lister_is_owner_same_verified_phone" },
        actorRole: "system",
      });
      await tx.update(propertyAuthorizations).set({ status: "active" }).where(eq(propertyAuthorizations.id, auth.id));
    }
    await enqueue(tx, "trust.dedupe_property", { propertyId: p.id });
    return { property: p, authorizationId: auth.id };
  });
  return result;
}

export async function addUnit(user: SessionUser, propertyId: string, input: z.input<typeof unitSchema>) {
  await loadPropertyForOrg(user, propertyId);
  const u = unitSchema.parse(input);
  return db.transaction(async (tx) => {
    const [unit] = await tx.insert(units).values({ ...u, propertyId }).returning();
    if (u.kind === "pg_room") for (let i = 0; i < (u.sharingCapacity ?? 1); i++) await tx.insert(beds).values({ unitId: unit.id, label: String.fromCharCode(65 + i) });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "unit.created", subjectType: "property", subjectId: propertyId, data: { unitId: unit.id } });
    return unit;
  });
}

// ---------- listings ----------

export const listingSchema = z.object({
  propertyId: z.string().uuid(),
  category: z.enum(["pg", "rent", "short_stay"]),
  title: z.string().trim().min(8).max(90),
  description: z.string().trim().max(3000).default(""),
  unitIds: z.array(z.string().uuid()).min(1),
  terms: z.record(z.string(), z.unknown()).default({}),
});

export async function createListing(user: SessionUser, input: z.input<typeof listingSchema>) {
  const v = listingSchema.parse(input);
  const p = await loadPropertyForOrg(user, v.propertyId);
  const mod = moderateText(`${v.title}\n${v.description}`);
  if (!mod.ok) throw new DomainError("Please edit the title/description", "invalid", mod.errors);
  const [auth] = await db
    .select()
    .from(propertyAuthorizations)
    .where(and(eq(propertyAuthorizations.propertyId, p.id), inArray(propertyAuthorizations.orgId, user.orgs.map((o) => o.id)), ne(propertyAuthorizations.status, "revoked")))
    .orderBy(desc(propertyAuthorizations.createdAt))
    .limit(1);
  if (!auth) throw new DomainError("Your organisation has no authorisation for this property", "forbidden");
  const unitRows = await db.select().from(units).where(and(eq(units.propertyId, p.id), inArray(units.id, v.unitIds)));
  if (unitRows.length !== v.unitIds.length) throw new DomainError("Some selected units do not belong to this property");
  const scope = v.category === "pg" ? "beds" : v.category === "short_stay" ? "room_types" : "units";
  const [loc] = await db.select().from(localities).where(eq(localities.id, p.localityId));
  const sid = shortId();
  return db.transaction(async (tx) => {
    const [l] = await tx
      .insert(listings)
      .values({
        shortId: sid,
        slug: `${slugify(`${v.title} ${loc?.name ?? ""}`)}-${sid}`,
        propertyId: p.id,
        orgId: auth.orgId,
        listerUserId: user.id,
        authorizationId: auth.id,
        category: v.category,
        scope,
        title: v.title,
        description: v.description,
        terms: v.terms,
      })
      .returning();
    for (const uid of v.unitIds) await tx.insert(listingUnits).values({ listingId: l.id, unitId: uid });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "listing.created", subjectType: "listing", subjectId: l.id, data: { category: v.category } });
    return l;
  });
}

export async function updateListingDetails(user: SessionUser, listingId: string, input: { title: string; description: string; terms?: Record<string, unknown> }) {
  const l = await loadListingForOrg(user, listingId);
  const title = input.title.trim();
  if (title.length < 8 || title.length > 90) throw new DomainError("Title must be 8–90 characters");
  const mod = moderateText(`${title}\n${input.description}`);
  if (!mod.ok) throw new DomainError("Please edit the text", "invalid", mod.errors);
  await db.transaction(async (tx) => {
    await tx
      .update(listings)
      .set({ title, description: input.description.trim(), terms: input.terms ?? l.terms, updatedAt: new Date() })
      .where(eq(listings.id, listingId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "listing.details_updated", subjectType: "listing", subjectId: listingId });
  });
}

// ---------- pricing (insert-only versions) ----------

const chargeSchema = z.object({
  code: z.string().min(2).max(40),
  mode: z.enum(["fixed", "months_of_rent", "percent", "metered", "included", "none"]),
  amountPaise: z.coerce.number().int().min(0).max(1e10).optional().nullable(),
  months: z.coerce.number().min(0).max(24).optional().nullable(),
  percent: z.coerce.number().min(0).max(100).optional().nullable(),
  recurrence: z.enum(["one_time", "monthly", "nightly"]),
  refundable: z.boolean().default(false),
  mandatory: z.boolean().default(true),
  note: z.string().max(120).optional().nullable(),
});

export const planSchema = z.object({
  planKey: z.string().min(1).max(80),
  unitId: z.string().uuid().optional().nullable(),
  appliesTo: z.enum(["bed_single", "bed_double", "bed_triple", "bed_quad", "unit_monthly", "room_type_nightly"]),
  label: z.string().trim().min(2).max(60),
  basePaise: z.coerce.number().int().min(100).max(1e10),
  period: z.enum(["month", "night"]),
  mealPlan: z.string().max(60).optional().nullable(),
  charges: z.array(chargeSchema).max(20),
});

export async function setPricePlan(user: SessionUser, listingId: string, input: z.input<typeof planSchema>) {
  const l = await loadListingForOrg(user, listingId);
  const v = planSchema.parse(input);
  const errs = disclosureErrors(v as PlanInput);
  if (errs.length) throw new DomainError("Pricing is incomplete", "invalid", errs);
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(pricePlans)
      .where(and(eq(pricePlans.listingId, listingId), eq(pricePlans.planKey, v.planKey), isNull(pricePlans.supersededAt)))
      .for("update");
    const now = new Date();
    if (cur) await tx.update(pricePlans).set({ supersededAt: now }).where(eq(pricePlans.id, cur.id));
    const [plan] = await tx
      .insert(pricePlans)
      .values({
        listingId,
        unitId: v.unitId ?? null,
        planKey: v.planKey,
        appliesTo: v.appliesTo,
        label: v.label,
        basePaise: v.basePaise,
        period: v.period,
        mealPlan: v.mealPlan ?? null,
        version: (cur?.version ?? 0) + 1,
        effectiveFrom: now,
        createdBy: user.id,
      })
      .returning();
    for (const c of v.charges) await tx.insert(charges).values({ ...c, pricePlanId: plan.id });
    const summary = computeCostSummary({ ...v, charges: v.charges as ChargeInput[] });
    await writeAudit(tx, {
      actorUserId: user.id,
      actorRole: "lister",
      action: cur ? "price_plan.revised" : "price_plan.created",
      subjectType: "listing",
      subjectId: listingId,
      data: {
        planKey: v.planKey,
        version: plan.version,
        basePaise: v.basePaise,
        previousBasePaise: cur?.basePaise ?? null,
        depositPaise: summary.depositPaise,
        brokeragePaise: summary.brokeragePaise,
      },
    });
    if (l.status === "published") await upsertChargesDisclosedCheck(tx, listingId);
    return plan;
  });
}

export async function retirePricePlan(user: SessionUser, listingId: string, planKey: string) {
  await loadListingForOrg(user, listingId);
  await db.transaction(async (tx) => {
    await tx
      .update(pricePlans)
      .set({ supersededAt: new Date() })
      .where(and(eq(pricePlans.listingId, listingId), eq(pricePlans.planKey, planKey), isNull(pricePlans.supersededAt)));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "price_plan.retired", subjectType: "listing", subjectId: listingId, data: { planKey } });
  });
}

export async function currentPlans(listingId: string, exec: Exec = db) {
  const plans = await exec
    .select()
    .from(pricePlans)
    .where(and(eq(pricePlans.listingId, listingId), isNull(pricePlans.supersededAt)))
    .orderBy(asc(pricePlans.basePaise));
  if (!plans.length) return [];
  const ch = await exec.select().from(charges).where(inArray(charges.pricePlanId, plans.map((p) => p.id)));
  return plans.map((p) => {
    const input: PlanInput = {
      planKey: p.planKey,
      appliesTo: p.appliesTo,
      label: p.label,
      basePaise: p.basePaise,
      period: p.period as "month" | "night",
      mealPlan: p.mealPlan,
      charges: ch
        .filter((c) => c.pricePlanId === p.id)
        .map((c) => ({
          code: c.code,
          mode: c.mode as ChargeInput["mode"],
          amountPaise: c.amountPaise,
          months: c.months,
          percent: c.percent,
          recurrence: c.recurrence as ChargeInput["recurrence"],
          refundable: c.refundable,
          mandatory: c.mandatory,
          note: c.note,
        })),
    };
    return { plan: p, input, summary: computeCostSummary(input) };
  });
}

export async function priceHistory(listingId: string) {
  return db
    .select({ planKey: pricePlans.planKey, label: pricePlans.label, version: pricePlans.version, basePaise: pricePlans.basePaise, effectiveFrom: pricePlans.effectiveFrom, supersededAt: pricePlans.supersededAt })
    .from(pricePlans)
    .where(eq(pricePlans.listingId, listingId))
    .orderBy(asc(pricePlans.planKey), asc(pricePlans.version));
}

async function upsertChargesDisclosedCheck(tx: Exec, listingId: string) {
  const plans = await currentPlans(listingId, tx);
  const ok = plans.length > 0 && plans.every((p) => disclosureErrors(p.input).length === 0);
  await addCheck(tx, {
    subjectType: "listing",
    subjectId: listingId,
    checkType: "charges_disclosed",
    status: ok ? "passed" : "failed",
    method: "automated",
    data: { plans: plans.length },
  });
}

// ---------- availability ----------

async function touchConfirmed(tx: Exec, listingIds: string[], by: string) {
  if (!listingIds.length) return;
  const now = new Date();
  await tx.update(listings).set({ lastConfirmedAt: now, lastConfirmedBy: by, updatedAt: now }).where(inArray(listings.id, listingIds));
  await tx
    .update(listings)
    .set({ status: "published" })
    .where(and(inArray(listings.id, listingIds), inArray(listings.status, ["stale", "paused"]), sql`${listings.publishedAt} is not null`));
}

async function listingsForUnit(tx: Exec, unitId: string) {
  const rows = await tx.select({ id: listingUnits.listingId }).from(listingUnits).where(eq(listingUnits.unitId, unitId));
  return rows.map((r) => r.id);
}

export async function setBedStatus(
  user: SessionUser,
  bedId: string,
  input: { status: "vacant" | "occupied" | "notice" | "reserved" | "blocked"; noticeUntil?: string | null; reservedUntil?: string | null },
) {
  const [row] = await db.select({ bed: beds, unit: units }).from(beds).innerJoin(units, eq(units.id, beds.unitId)).where(eq(beds.id, bedId));
  if (!row) throw new DomainError("Bed not found", "not_found");
  await loadPropertyForOrg(user, row.unit.propertyId);
  if (input.status === "notice" && !input.noticeUntil) throw new DomainError("Give the date the current occupant leaves");
  if (input.status === "reserved" && !input.reservedUntil) throw new DomainError("Give the date the reservation ends");
  await db.transaction(async (tx) => {
    await tx
      .update(beds)
      .set({ status: input.status, statusSince: new Date(), noticeUntil: input.noticeUntil ?? null, reservedUntil: input.reservedUntil ?? null })
      .where(eq(beds.id, bedId));
    const ls = await listingsForUnit(tx, row.unit.id);
    await touchConfirmed(tx, ls, "lister");
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "availability.bed", subjectType: "unit", subjectId: row.unit.id, data: { bedId, ...input } });
  });
}

export async function setUnitAvailability(
  user: SessionUser,
  unitId: string,
  input: { availableFrom: string; minLeaseMonths?: number | null; status: "available" | "let_out" | "on_hold" },
) {
  const [u] = await db.select().from(units).where(eq(units.id, unitId));
  if (!u) throw new DomainError("Unit not found", "not_found");
  await loadPropertyForOrg(user, u.propertyId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.availableFrom)) throw new DomainError("Pick an available-from date");
  await db.transaction(async (tx) => {
    await tx.insert(availability).values({ unitId, availableFrom: input.availableFrom, minLeaseMonths: input.minLeaseMonths ?? null, status: input.status, source: "lister" });
    const ls = await listingsForUnit(tx, unitId);
    await touchConfirmed(tx, ls, "lister");
    if (input.status === "let_out") {
      for (const id of ls) {
        await tx.update(listings).set({ status: "closed", updatedAt: new Date() }).where(and(eq(listings.id, id), inArray(listings.status, ["published", "stale", "paused"])));
        await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "listing.closed", subjectType: "listing", subjectId: id, data: { reason: "let_out" } });
      }
    }
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "availability.unit", subjectType: "unit", subjectId: unitId, data: input });
  });
}

export async function setNightlyInventory(
  user: SessionUser,
  unitId: string,
  input: { from: string; to: string; availableCount: number; ratePaise: number; minStay?: number },
) {
  const [u] = await db.select().from(units).where(eq(units.id, unitId));
  if (!u || u.kind !== "hotel_room_type") throw new DomainError("Room type not found", "not_found");
  await loadPropertyForOrg(user, u.propertyId);
  if (input.availableCount < 0 || input.availableCount > (u.inventoryCount ?? 999)) throw new DomainError(`Available rooms must be between 0 and ${u.inventoryCount}`);
  if (!(input.ratePaise > 0)) throw new DomainError("Nightly rate must be greater than zero");
  const days: string[] = [];
  for (let d = new Date(input.from + "T00:00:00Z"); d <= new Date(input.to + "T00:00:00Z") && days.length < 366; d = new Date(d.getTime() + 86400_000)) days.push(d.toISOString().slice(0, 10));
  if (!days.length) throw new DomainError("Pick a valid date range");
  await db.transaction(async (tx) => {
    for (const date of days) {
      await tx
        .insert(nightlyInventory)
        .values({ unitId, date, availableCount: input.availableCount, ratePaise: input.ratePaise, minStay: input.minStay ?? 1 })
        .onConflictDoUpdate({
          target: [nightlyInventory.unitId, nightlyInventory.date],
          set: { availableCount: input.availableCount, ratePaise: input.ratePaise, minStay: input.minStay ?? 1, syncedAt: new Date() },
        });
    }
    await touchConfirmed(tx, await listingsForUnit(tx, unitId), "lister");
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "availability.nightly", subjectType: "unit", subjectId: unitId, data: { ...input, days: days.length } });
  });
}

export async function reconfirmListing(user: SessionUser, listingId: string, via: "dashboard" | "whatsapp" = "dashboard") {
  const l = await loadListingForOrg(user, listingId);
  if (!["published", "stale", "paused"].includes(l.status)) throw new DomainError(`A ${l.status} listing cannot be reconfirmed`, "conflict");
  await db.transaction(async (tx) => {
    await touchConfirmed(tx, [listingId], via === "whatsapp" ? "lister (WhatsApp)" : "lister");
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "listing.reconfirmed", subjectType: "listing", subjectId: listingId, data: { via } });
  });
}

export async function setListingStatusByLister(user: SessionUser, listingId: string, to: "paused" | "closed") {
  const l = await loadListingForOrg(user, listingId);
  if (!["published", "stale", "paused"].includes(l.status)) throw new DomainError(`Cannot change a ${l.status} listing`, "conflict");
  await db.transaction(async (tx) => {
    await tx.update(listings).set({ status: to, updatedAt: new Date() }).where(eq(listings.id, listingId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: `listing.${to}`, subjectType: "listing", subjectId: listingId });
  });
}

// ---------- tours, zones, hotspots ----------

export async function tourForProperty(propertyId: string, exec: Exec = db) {
  const [t] = await exec.select().from(tours).where(eq(tours.propertyId, propertyId)).orderBy(desc(tours.version)).limit(1);
  if (t) return t;
  const [created] = await exec.insert(tours).values({ propertyId }).returning();
  return created;
}

export async function createZone(user: SessionUser, propertyId: string, input: { label: string; roomType: string; unitId?: string | null }) {
  await loadPropertyForOrg(user, propertyId);
  const label = input.label.trim();
  if (!label) throw new DomainError("Give the room a name");
  const mod = moderateText(label);
  if (!mod.ok) throw new DomainError("Please change the room name", "invalid", mod.errors);
  const t = await tourForProperty(propertyId);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(zones).where(eq(zones.tourId, t.id));
  const [z] = await db.insert(zones).values({ tourId: t.id, label, roomType: input.roomType, unitId: input.unitId ?? null, sort: n }).returning();
  return z;
}

async function loadZoneForOrg(user: SessionUser, zoneId: string) {
  const [row] = await db.select({ zone: zones, tour: tours }).from(zones).innerJoin(tours, eq(tours.id, zones.tourId)).where(eq(zones.id, zoneId));
  if (!row) throw new DomainError("Room not found", "not_found");
  await loadPropertyForOrg(user, row.tour.propertyId);
  return row;
}

export async function updateZone(
  user: SessionUser,
  zoneId: string,
  input: { label?: string; roomType?: string; unitId?: string | null; roomDims?: Partial<RoomDims>; startYaw?: number; panoAssetId?: string | null; photoAssetIds?: string[] },
) {
  const { zone } = await loadZoneForOrg(user, zoneId);
  const patch: Partial<typeof zones.$inferInsert> = {};
  if (input.label !== undefined) patch.label = input.label.trim();
  if (input.roomType !== undefined) patch.roomType = input.roomType;
  if (input.unitId !== undefined) patch.unitId = input.unitId;
  if (input.startYaw !== undefined) patch.startYaw = input.startYaw;
  if (input.panoAssetId !== undefined) patch.panoAssetId = input.panoAssetId;
  if (input.photoAssetIds !== undefined) patch.photoAssetIds = input.photoAssetIds;
  if (input.roomDims) patch.roomDims = validateRoomDims({ ...(zone.roomDims as RoomDims), ...input.roomDims });
  await db.update(zones).set(patch).where(eq(zones.id, zoneId));
  if (input.roomDims) await recomputeHotspotPositions(zoneId);
}

export async function deleteZone(user: SessionUser, zoneId: string) {
  await loadZoneForOrg(user, zoneId);
  await db.delete(zones).where(eq(zones.id, zoneId));
}

export async function requestSplatBuild(user: SessionUser, zoneId: string) {
  const { zone } = await loadZoneForOrg(user, zoneId);
  if (!zone.panoAssetId) throw new DomainError("Add a 360° capture to this room first");
  await db.transaction(async (tx) => {
    await tx.update(zones).set({ splatStatus: "queued", splatNote: null }).where(eq(zones.id, zoneId));
    await enqueue(tx, "scene.build_from_pano", { zoneId });
  });
}

async function recomputeHotspotPositions(zoneId: string) {
  const [z] = await db.select().from(zones).where(eq(zones.id, zoneId));
  const hs = await db.select().from(hotspots).where(eq(hotspots.zoneId, zoneId));
  for (const h of hs) {
    await db
      .update(hotspots)
      .set({ position: positionFromYawPitch(h.yaw, h.pitch, z.roomDims as RoomDims) })
      .where(eq(hotspots.id, h.id));
  }
}

const hotspotSchema = z.object({
  type: z.enum(["room_label", "amenity", "issue_disclosure", "door_to_zone", "view", "info"]),
  yaw: z.number().min(-Math.PI * 2).max(Math.PI * 2),
  pitch: z.number().min(-Math.PI / 2).max(Math.PI / 2),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().max(500).default(""),
  targetZoneId: z.string().uuid().optional().nullable(),
});

export async function addHotspot(user: SessionUser, zoneId: string, input: z.input<typeof hotspotSchema>) {
  const { zone } = await loadZoneForOrg(user, zoneId);
  const v = hotspotSchema.parse(input);
  const mod = moderateText(`${v.title}\n${v.body}`);
  if (!mod.ok) throw new DomainError("Please edit the hotspot text", "invalid", mod.errors);
  if (v.type === "door_to_zone" && !v.targetZoneId) throw new DomainError("Choose which room this door leads to");
  const [h] = await db
    .insert(hotspots)
    .values({ ...v, zoneId, position: positionFromYawPitch(v.yaw, v.pitch, zone.roomDims as RoomDims), createdBy: user.id })
    .returning();
  return h;
}

export async function deleteHotspot(user: SessionUser, hotspotId: string) {
  const [h] = await db.select().from(hotspots).where(eq(hotspots.id, hotspotId));
  if (!h) throw new DomainError("Hotspot not found", "not_found");
  await loadZoneForOrg(user, h.zoneId);
  if (h.locked && !user.roles.includes("admin")) throw new DomainError("This disclosure is locked after a renter report; contact support", "forbidden");
  await db.transaction(async (tx) => {
    await tx.delete(hotspots).where(eq(hotspots.id, hotspotId));
    if (h.type === "issue_disclosure") await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "hotspot.disclosure_removed", subjectType: "zone", subjectId: h.zoneId, data: { title: h.title } });
  });
}

// ---------- publishing ----------

export interface PublishChecklist {
  errors: string[];
  warnings: string[];
}

export async function publishChecklist(listingId: string, exec: Exec = db): Promise<PublishChecklist> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const [l] = await exec.select().from(listings).where(eq(listings.id, listingId));
  if (!l) return { errors: ["Listing not found"], warnings };
  const auth = l.authorizationId ? (await exec.select().from(propertyAuthorizations).where(eq(propertyAuthorizations.id, l.authorizationId)))[0] : null;
  if (!auth) errors.push("No property authorisation");
  else if (auth.status !== "active") errors.push("The owner has not confirmed your authorisation yet (Verification tab → Ask owner to confirm)");
  const plans = await currentPlans(listingId, exec);
  if (!plans.length) errors.push("Add at least one price plan");
  for (const p of plans) errors.push(...disclosureErrors(p.input));
  if (l.category === "short_stay" && plans.some((p) => p.plan.period !== "night")) errors.push("Hotel plans must be priced per night");
  if (l.category !== "short_stay" && plans.some((p) => p.plan.period !== "month")) errors.push("Rental plans must be priced per month");
  const lu = await exec.select({ unit: units }).from(listingUnits).innerJoin(units, eq(units.id, listingUnits.unitId)).where(eq(listingUnits.listingId, listingId));
  const unitIds = lu.map((r) => r.unit.id);
  const media = await exec
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.propertyId, l.propertyId), inArray(mediaAssets.kind, ["photo", "pano"]), eq(mediaAssets.status, "ready")));
  if (media.length < 3) errors.push("Add at least 3 photos or 360° captures");
  const t = await tourForProperty(l.propertyId, exec);
  const zs = await exec.select().from(zones).where(eq(zones.tourId, t.id));
  for (const r of lu) {
    // In a single-unit listing (a flat/house), common-area captures also show that unit.
    const single = lu.length === 1;
    const hasMedia =
      media.some((m) => m.unitId === r.unit.id || (single && m.unitId === null)) ||
      zs.some((z) => (z.unitId === r.unit.id || (single && z.unitId === null)) && (z.panoAssetId || z.photoAssetIds.length));
    if (!hasMedia) errors.push(`Add a photo or 360° capture for "${r.unit.label}"`);
  }
  if (l.category === "pg") {
    const b = unitIds.length ? await exec.select().from(beds).where(inArray(beds.unitId, unitIds)) : [];
    if (!b.length) errors.push("PG rooms need beds");
    if (!plans.some((p) => p.plan.appliesTo.startsWith("bed_"))) errors.push("Add per-bed pricing for at least one sharing type");
  }
  if (l.category === "rent") {
    const av = unitIds.length ? await exec.select().from(availability).where(inArray(availability.unitId, unitIds)) : [];
    if (!av.length) errors.push("Set the available-from date");
  }
  if (l.category === "short_stay") {
    const today = todayIST();
    const inv = unitIds.length
      ? await exec.select().from(nightlyInventory).where(and(inArray(nightlyInventory.unitId, unitIds), gte(nightlyInventory.date, today)))
      : [];
    if (inv.length < 7) errors.push("Load at least 7 days of nightly availability and rates");
  }
  const mod = moderateText(`${l.title}\n${l.description}`);
  errors.push(...mod.errors);
  if (!zs.some((z) => z.panoAssetId)) warnings.push("No 360° room tour yet: listings with tours get more enquiries");
  if (zs.some((z) => z.panoAssetId) && !zs.some((z) => z.splatStatus === "ready")) warnings.push("Optional: build a 3D walkthrough for at least one room");
  const pending = await exec.select().from(mediaAssets).where(and(eq(mediaAssets.propertyId, l.propertyId), inArray(mediaAssets.status, ["uploaded", "processing"])));
  if (pending.length) warnings.push(`${pending.length} upload(s) are still processing`);
  return { errors: [...new Set(errors)], warnings };
}

export async function publishListing(user: SessionUser, listingId: string) {
  const l = await loadListingForOrg(user, listingId);
  if (!["draft", "pending_review", "expired", "closed", "paused"].includes(l.status) && l.status !== "stale")
    throw new DomainError(`Listing is already ${l.status}`, "conflict");
  const check = await publishChecklist(listingId);
  if (check.errors.length) throw new DomainError("Fix these before publishing", "blocked", check.errors);
  const now = new Date();
  await db.transaction(async (tx) => {
    const poster = await choosePoster(tx, l.propertyId);
    await tx
      .update(listings)
      .set({ status: "published", publishedAt: l.publishedAt ?? now, lastConfirmedAt: now, lastConfirmedBy: "lister", posterAssetId: l.posterAssetId ?? poster, updatedAt: now })
      .where(eq(listings.id, listingId));
    await upsertChargesDisclosedCheck(tx, listingId);
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "listing.published", subjectType: "listing", subjectId: listingId });
    await enqueue(tx, "trust.onsite_check", { listingId });
  });
}

async function choosePoster(tx: Exec, propertyId: string): Promise<string | null> {
  const [p] = await tx
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.propertyId, propertyId), inArray(mediaAssets.kind, ["pano", "photo"]), eq(mediaAssets.status, "ready")))
    .orderBy(sql`case when ${mediaAssets.kind} = 'pano' then 0 else 1 end`, asc(mediaAssets.createdAt))
    .limit(1);
  return p?.id ?? null;
}

// ---------- read models ----------

export function mediaUrls(a: typeof mediaAssets.$inferSelect | undefined | null) {
  if (!a) return null;
  const v = (a.variants ?? {}) as Record<string, string>;
  const u = (k: string) => (v[k] ? publicUrl(v[k]) : null);
  return {
    id: a.id,
    kind: a.kind,
    full: u("full"),
    mobile: u("mobile"),
    thumb: u("thumb"),
    poster: u("poster"),
    desktop: u("desktop"),
    width: a.width,
    height: a.height,
    meta: a.meta as Record<string, unknown>,
  };
}

export async function getTourData(propertyId: string, unitIds: string[] | null) {
  const t = await tourForProperty(propertyId);
  const zs = await db.select().from(zones).where(eq(zones.tourId, t.id)).orderBy(asc(zones.sort));
  const visible = zs.filter((z) => !unitIds || !z.unitId || unitIds.includes(z.unitId));
  const assetIds = [...new Set(visible.flatMap((z) => [z.panoAssetId, z.splatAssetId, ...z.photoAssetIds].filter((x): x is string => !!x)))];
  const assets = assetIds.length ? await db.select().from(mediaAssets).where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.status, "ready"))) : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const hs = visible.length ? await db.select().from(hotspots).where(inArray(hotspots.zoneId, visible.map((z) => z.id))) : [];
  return visible.map((z) => {
    const pano = z.panoAssetId ? mediaUrls(byId.get(z.panoAssetId)) : null;
    const splat = z.splatStatus === "ready" && z.splatAssetId ? mediaUrls(byId.get(z.splatAssetId)) : null;
    return {
      id: z.id,
      label: z.label,
      roomType: z.roomType,
      unitId: z.unitId,
      startYaw: z.startYaw,
      roomDims: z.roomDims as RoomDims,
      scaleStatus: z.scaleStatus,
      splatStatus: z.splatStatus,
      splatNote: z.splatNote,
      pano: pano ? { url: pano.full, mobileUrl: pano.mobile, thumb: pano.thumb, poster: pano.poster } : null,
      splat: splat
        ? { url: splat.desktop, mobileUrl: splat.mobile, splats: (splat.meta?.splatsDesktop as number) ?? null, bytes: (splat.meta?.bytesDesktop as number) ?? null }
        : null,
      photos: z.photoAssetIds
        .map((id) => mediaUrls(byId.get(id)))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({ id: m.id, url: m.full!, thumb: m.thumb! })),
      hotspots: hs
        .filter((h) => h.zoneId === z.id)
        .map((h) => ({ id: h.id, type: h.type, yaw: h.yaw, pitch: h.pitch, position: h.position as [number, number, number] | null, title: h.title, body: h.body, targetZoneId: h.targetZoneId })),
    };
  });
}

export type TourZone = Awaited<ReturnType<typeof getTourData>>[number];

const PUBLIC_STATUSES = ["published", "stale"];

export async function getListingView(slug: string, viewer: SessionUser | null) {
  const [l] = await db.select().from(listings).where(eq(listings.slug, slug));
  if (!l) return null;
  const isOwner = !!viewer && (viewer.orgs.some((o) => o.id === l.orgId) || viewer.roles.includes("admin"));
  if (!PUBLIC_STATUSES.includes(l.status) && !isOwner) return { listing: l, unavailable: true as const };
  const [p] = await db.select().from(properties).where(eq(properties.id, l.propertyId));
  const [loc] = await db.select().from(localities).where(eq(localities.id, p.localityId));
  const [org] = await db.select().from(organizations).where(eq(organizations.id, l.orgId));
  const { brokerProfiles } = await import("./schema");
  const [lister] = await db
    .select({ name: users.name, profileName: brokerProfiles.displayName, activeSince: brokerProfiles.activeSince })
    .from(users)
    .leftJoin(brokerProfiles, eq(brokerProfiles.userId, users.id))
    .where(eq(users.id, l.listerUserId));
  const lu = await db.select({ unit: units }).from(listingUnits).innerJoin(units, eq(units.id, listingUnits.unitId)).where(eq(listingUnits.listingId, l.id)).orderBy(asc(units.sort));
  const unitList = lu.map((r) => r.unit);
  const unitIds = unitList.map((u) => u.id);
  const plans = await currentPlans(l.id);
  const today = todayIST();
  const bedRows = unitIds.length ? await db.select().from(beds).where(inArray(beds.unitId, unitIds)).orderBy(asc(beds.label)) : [];
  const rooms: RoomBeds[] = unitList
    .filter((u) => u.kind === "pg_room")
    .map((u) => ({ unitId: u.id, sharing: u.sharingCapacity ?? 1, beds: bedRows.filter((b) => b.unitId === u.id) }));
  const avRows = unitIds.length
    ? await db.select().from(availability).where(inArray(availability.unitId, unitIds)).orderBy(desc(availability.createdAt))
    : [];
  const latestAvailability = new Map<string, typeof availability.$inferSelect>();
  for (const a of avRows) if (!latestAvailability.has(a.unitId)) latestAvailability.set(a.unitId, a);
  const inv = l.category === "short_stay" && unitIds.length
    ? await db
        .select()
        .from(nightlyInventory)
        .where(and(inArray(nightlyInventory.unitId, unitIds), gte(nightlyInventory.date, today), lte(nightlyInventory.date, addDaysIso(today, 60))))
        .orderBy(asc(nightlyInventory.date))
    : [];
  const { badges } = await badgesForListing(l);
  const tour = await getTourData(l.propertyId, unitIds);
  const poster = l.posterAssetId ? mediaUrls((await db.select().from(mediaAssets).where(eq(mediaAssets.id, l.posterAssetId)))[0]) : null;
  const others = await db
    .select({ id: listings.id, slug: listings.slug, orgName: organizations.displayName, title: listings.title })
    .from(listings)
    .innerJoin(organizations, eq(organizations.id, listings.orgId))
    .where(and(eq(listings.propertyId, l.propertyId), ne(listings.id, l.id), inArray(listings.status, ["published"])));
  const otherPlans = await Promise.all(others.map(async (o) => ({ ...o, plans: await currentPlans(o.id) })));
  return {
    unavailable: false as const,
    isOwner,
    listing: l,
    property: p,
    locality: loc,
    org,
    lister: { name: lister?.profileName ?? lister?.name ?? org.displayName, activeSince: lister?.activeSince ?? null },
    units: unitList,
    plans,
    pg: rooms.length ? pgAvailability(rooms, today) : [],
    rooms: rooms.map((r) => ({ ...r, label: unitList.find((u) => u.id === r.unitId)?.label ?? "" })),
    availability: unitList.map((u) => ({ unitId: u.id, label: u.label, latest: latestAvailability.get(u.id) ?? null })),
    nightly: inv,
    badges,
    freshness: freshnessState(l.category as ListingCategory, l.lastConfirmedAt),
    tour,
    poster,
    otherListers: otherPlans,
  };
}

export type ListingView = Exclude<Awaited<ReturnType<typeof getListingView>>, null | { unavailable: true }>;

function addDaysIso(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

// ---------- search ----------

export const searchSchema = z.object({
  category: z.enum(["pg", "rent", "short_stay"]).optional(),
  locality: z.string().optional(),
  maxBudget: z.coerce.number().int().positive().optional(), // rupees per month / per night
  sharing: z.coerce.number().int().min(1).max(4).optional(),
  gender: z.enum(["female", "male", "coed"]).optional(),
  noBrokerage: z.coerce.boolean().optional(),
  has3d: z.coerce.boolean().optional(),
  ownerAuthorised: z.coerce.boolean().optional(),
  moveIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "newest"]).default("relevance"),
});

export type SearchFilters = z.input<typeof searchSchema>;

export async function searchListings(filters: SearchFilters) {
  const f = searchSchema.parse(filters);
  const conds = [eq(listings.status, "published")];
  if (f.category) conds.push(eq(listings.category, f.category));
  if (f.locality) conds.push(eq(properties.localityId, f.locality));
  if (f.gender) conds.push(sql`${properties.houseRules}->>'gender' = ${f.gender}`);
  const rows = await db
    .select({ listing: listings, property: properties, locality: localities })
    .from(listings)
    .innerJoin(properties, eq(properties.id, listings.propertyId))
    .innerJoin(localities, eq(localities.id, properties.localityId))
    .where(and(...conds))
    .limit(200);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.listing.id);
  const planRows = await Promise.all(ids.map((id) => currentPlans(id)));
  const badgeMap = await badgesForListings(rows.map((r) => r.listing));
  const tourInfo = await db
    .select({ propertyId: tours.propertyId, panos: sql<number>`count(${zones.panoAssetId})::int`, splats: sql<number>`count(*) filter (where ${zones.splatStatus} = 'ready')::int` })
    .from(tours)
    .innerJoin(zones, eq(zones.tourId, tours.id))
    .where(inArray(tours.propertyId, rows.map((r) => r.property.id)))
    .groupBy(tours.propertyId);
  const posterIds = rows.map((r) => r.listing.posterAssetId).filter((x): x is string => !!x);
  const posters = posterIds.length ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, posterIds)) : [];
  const today = todayIST();
  let results = rows.map((r, i) => {
    const plans = planRows[i];
    const min = plans[0];
    const ti = tourInfo.find((t) => t.propertyId === r.property.id);
    const badges = badgeMap.get(r.listing.id) ?? [];
    return {
      id: r.listing.id,
      slug: r.listing.slug,
      title: r.listing.title,
      category: r.listing.category,
      locality: r.locality.name,
      localityId: r.locality.id,
      nearestMetro: r.locality.nearestMetro,
      houseRules: r.property.houseRules as Record<string, unknown>,
      plans: plans.map((p) => p.summary),
      fromPaise: min?.summary.basePaise ?? 0,
      period: min?.summary.period ?? "month",
      noBrokerage: plans.length > 0 && plans.every((p) => (p.summary.brokeragePaise ?? 0) === 0 && p.summary.brokerageDisclosed),
      has360: (ti?.panos ?? 0) > 0,
      has3d: (ti?.splats ?? 0) > 0,
      badges,
      freshness: freshnessState(r.listing.category as ListingCategory, r.listing.lastConfirmedAt),
      lastConfirmedAt: r.listing.lastConfirmedAt,
      publishedAt: r.listing.publishedAt,
      poster: mediaUrls(posters.find((p) => p.id === r.listing.posterAssetId)),
      propertyId: r.property.id,
    };
  });
  if (f.maxBudget) results = results.filter((r) => r.fromPaise <= f.maxBudget! * 100);
  if (f.noBrokerage) results = results.filter((r) => r.noBrokerage);
  if (f.has3d) results = results.filter((r) => r.has3d);
  if (f.ownerAuthorised) results = results.filter((r) => r.badges.find((b) => b.key === "owner_authorised")?.earned);
  if (f.sharing) results = results.filter((r) => r.category !== "pg" || r.plans.some((p) => p.planKey === `bed_${["", "single", "double", "triple", "quad"][f.sharing!]}`));
  if (f.moveIn && f.category !== "short_stay") {
    const ok = new Set<string>();
    for (const r of results) {
      if (r.category === "pg") {
        const lu = await db.select({ unitId: listingUnits.unitId, sharing: units.sharingCapacity }).from(listingUnits).innerJoin(units, eq(units.id, listingUnits.unitId)).where(eq(listingUnits.listingId, r.id));
        const b = lu.length ? await db.select().from(beds).where(inArray(beds.unitId, lu.map((x) => x.unitId))) : [];
        const { pgHasBedFor } = await import("@/lib/availability");
        const rooms = lu.map((x) => ({ unitId: x.unitId, sharing: x.sharing ?? 1, beds: b.filter((y) => y.unitId === x.unitId) }));
        if (pgHasBedFor(rooms, f.moveIn, today, f.sharing)) ok.add(r.id);
      } else if (r.category === "rent") {
        const lu = await db.select({ unitId: listingUnits.unitId }).from(listingUnits).where(eq(listingUnits.listingId, r.id));
        const av = lu.length ? await db.select().from(availability).where(inArray(availability.unitId, lu.map((x) => x.unitId))).orderBy(desc(availability.createdAt)) : [];
        const latest = new Map<string, (typeof av)[number]>();
        for (const a of av) if (!latest.has(a.unitId)) latest.set(a.unitId, a);
        if ([...latest.values()].some((a) => a.status === "available" && a.availableFrom <= f.moveIn!)) ok.add(r.id);
      } else ok.add(r.id);
    }
    results = results.filter((r) => ok.has(r.id));
  }
  const trustScore = (r: (typeof results)[number]) => r.badges.filter((b) => b.earned).length * 2 + (r.freshness === "fresh" ? 2 : r.freshness === "due_soon" ? 1 : 0) + (r.has3d ? 1 : 0) + (r.has360 ? 1 : 0);
  if (f.sort === "price_asc") results.sort((a, b) => a.fromPaise - b.fromPaise);
  else if (f.sort === "price_desc") results.sort((a, b) => b.fromPaise - a.fromPaise);
  else if (f.sort === "newest") results.sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime());
  else results.sort((a, b) => trustScore(b) - trustScore(a) || a.fromPaise - b.fromPaise);
  return results;
}

export type SearchResult = Awaited<ReturnType<typeof searchListings>>[number];

export async function allLocalities() {
  return db.select().from(localities).orderBy(asc(localities.name));
}

// ---------- lister dashboard ----------

export async function listerOverview(user: SessionUser) {
  const orgIds = user.orgs.map((o) => o.id);
  if (!orgIds.length) return { listings: [], properties: [] };
  const ls = await db
    .select({ listing: listings, property: properties, locality: localities })
    .from(listings)
    .innerJoin(properties, eq(properties.id, listings.propertyId))
    .innerJoin(localities, eq(localities.id, properties.localityId))
    .where(inArray(listings.orgId, orgIds))
    .orderBy(desc(listings.updatedAt));
  const props = await db
    .select({ property: properties, locality: localities })
    .from(properties)
    .innerJoin(localities, eq(localities.id, properties.localityId))
    .where(
      or(
        inArray(properties.createdByOrgId, orgIds),
        inArray(
          properties.id,
          db
            .select({ id: propertyAuthorizations.propertyId })
            .from(propertyAuthorizations)
            .where(and(inArray(propertyAuthorizations.orgId, orgIds), notInArray(propertyAuthorizations.status, ["revoked", "rejected"]))),
        ),
      ),
    )
    .orderBy(desc(properties.createdAt));
  return {
    listings: ls.map((r) => ({ ...r, freshness: freshnessState(r.listing.category as ListingCategory, r.listing.lastConfirmedAt) })),
    properties: props,
  };
}

export async function listingEditorData(user: SessionUser, listingId: string) {
  const l = await loadListingForOrg(user, listingId);
  const [p] = await db.select().from(properties).where(eq(properties.id, l.propertyId));
  const [loc] = await db.select().from(localities).where(eq(localities.id, p.localityId));
  const allUnits = await db.select().from(units).where(eq(units.propertyId, p.id)).orderBy(asc(units.sort));
  const lu = await db.select().from(listingUnits).where(eq(listingUnits.listingId, l.id));
  const unitIds = lu.map((x) => x.unitId);
  const bedRows = unitIds.length ? await db.select().from(beds).where(inArray(beds.unitId, unitIds)).orderBy(asc(beds.label)) : [];
  const avRows = unitIds.length ? await db.select().from(availability).where(inArray(availability.unitId, unitIds)).orderBy(desc(availability.createdAt)) : [];
  const inv = unitIds.length
    ? await db.select().from(nightlyInventory).where(and(inArray(nightlyInventory.unitId, unitIds), gte(nightlyInventory.date, todayIST()))).orderBy(asc(nightlyInventory.date)).limit(400)
    : [];
  const plans = await currentPlans(l.id);
  const history = await priceHistory(l.id);
  const media = await db.select().from(mediaAssets).where(eq(mediaAssets.propertyId, p.id)).orderBy(desc(mediaAssets.createdAt));
  const t = await tourForProperty(p.id);
  const zs = await db.select().from(zones).where(eq(zones.tourId, t.id)).orderBy(asc(zones.sort));
  const tour = await getTourData(p.id, null);
  const [auth] = l.authorizationId ? await db.select().from(propertyAuthorizations).where(eq(propertyAuthorizations.id, l.authorizationId)) : [];
  const [owner] = auth?.ownerContactId ? await db.select().from(ownerContacts).where(eq(ownerContacts.id, auth.ownerContactId)) : [];
  const { badges, checks } = await badgesForListing(l);
  const checklist = await publishChecklist(l.id);
  return {
    listing: l,
    property: p,
    locality: loc,
    allUnits,
    unitIds,
    beds: bedRows,
    availability: avRows,
    nightly: inv,
    plans,
    history,
    media: media.map((m) => ({ ...m, urls: mediaUrls(m) })),
    zones: zs,
    tour,
    authorization: auth ?? null,
    owner: owner ?? null,
    badges,
    checks,
    checklist,
    freshness: freshnessState(l.category as ListingCategory, l.lastConfirmedAt),
  };
}

export async function runOnsite(listingId: string) {
  await runOnsiteCheck(listingId);
}
