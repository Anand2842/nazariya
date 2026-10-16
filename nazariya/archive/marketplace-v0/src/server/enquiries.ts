// Engagement: enquiries (with price snapshots), message relay, visits, outcomes, hotel booking requests.
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIST } from "@/lib/availability";
import { formatINR } from "@/lib/money";
import { quoteStay } from "@/lib/pricing";
import { writeAudit } from "./audit";
import { maskPhone, type SessionUser } from "./auth";
import { db } from "./db";
import { DomainError } from "./errors";
import { currentPlans } from "./listings";
import { appUrl, queueNotification } from "./notify";
import {
  analyticsEvents,
  bookings,
  enquiries,
  enquiryMessages,
  listings,
  listingUnits,
  nightlyInventory,
  rentalOutcomes,
  units,
  users,
  visits,
} from "./schema";
import { maybeAutoPauseForUnavailable } from "./trust";

export const enquirySchema = z.object({
  listingId: z.string().uuid(),
  planKey: z.string().max(80).optional().nullable(),
  unitId: z.string().uuid().optional().nullable(),
  moveInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  stayFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  stayTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  guests: z.coerce.number().int().min(1).max(12).default(1),
  message: z.string().trim().max(1000).default(""),
});

export async function createEnquiry(renter: SessionUser, input: z.input<typeof enquirySchema>) {
  const v = enquirySchema.parse(input);
  const [l] = await db.select().from(listings).where(eq(listings.id, v.listingId));
  if (!l || l.status !== "published") throw new DomainError("This listing is not accepting enquiries right now", "conflict");
  if (renter.orgs.some((o) => o.id === l.orgId)) throw new DomainError("You cannot enquire on your own listing", "forbidden");
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enquiries)
    .where(and(eq(enquiries.renterUserId, renter.id), gte(enquiries.createdAt, new Date(Date.now() - 86400_000))));
  if (n >= 10) throw new DomainError("You have sent many enquiries today. Please try again tomorrow.", "blocked");
  const dup = await db
    .select({ id: enquiries.id })
    .from(enquiries)
    .where(and(eq(enquiries.renterUserId, renter.id), eq(enquiries.listingId, l.id), inArray(enquiries.status, ["new", "responded", "visit_scheduled"])));
  if (dup.length) throw new DomainError("You already have an open enquiry for this listing. Check My enquiries.", "conflict");
  const today = todayIST();
  if (v.moveInDate && v.moveInDate < today) throw new DomainError("Move-in date cannot be in the past");
  const plans = await currentPlans(l.id);
  const plan = plans.find((p) => p.plan.planKey === v.planKey) ?? plans[0];
  if (!plan) throw new DomainError("This listing has no pricing yet", "conflict");
  let quote = null;
  if (l.category === "short_stay") {
    if (!v.stayFrom || !v.stayTo) throw new DomainError("Choose check-in and check-out dates");
    if (v.stayFrom < today) throw new DomainError("Check-in cannot be in the past");
    const unitId = plan.plan.unitId ?? v.unitId;
    if (!unitId) throw new DomainError("Choose a room type");
    const inv = await db
      .select()
      .from(nightlyInventory)
      .where(and(eq(nightlyInventory.unitId, unitId), gte(nightlyInventory.date, v.stayFrom), lte(nightlyInventory.date, v.stayTo)));
    quote = quoteStay(
      inv.map((r) => ({ date: r.date, ratePaise: r.ratePaise, availableCount: r.availableCount, minStay: r.minStay, closedToArrival: r.closedToArrival })),
      v.stayFrom,
      v.stayTo,
      plan.input.charges,
    );
  }
  // The snapshot is the exact pricing shown at submission: evidence for later disputes.
  const snapshot = { capturedAt: new Date().toISOString(), plan: plan.summary, quote };
  return db.transaction(async (tx) => {
    const [e] = await tx
      .insert(enquiries)
      .values({
        listingId: l.id,
        unitId: plan.plan.unitId ?? v.unitId ?? null,
        planKey: plan.plan.planKey,
        renterUserId: renter.id,
        moveInDate: v.moveInDate ?? null,
        stayFrom: v.stayFrom ?? null,
        stayTo: v.stayTo ?? null,
        guests: v.guests,
        message: v.message,
        priceSnapshot: snapshot,
      })
      .returning();
    if (v.message) await tx.insert(enquiryMessages).values({ enquiryId: e.id, senderRole: "renter", senderUserId: renter.id, body: v.message });
    await tx.insert(enquiryMessages).values({
      enquiryId: e.id,
      senderRole: "system",
      body: `Enquiry for "${plan.summary.label}" at ${formatINR(plan.summary.basePaise)}/${plan.summary.period}. Price snapshot saved.`,
    });
    await queueNotification(tx, {
      userId: l.listerUserId,
      template: "new_enquiry",
      body: `New enquiry on "${l.title}" (${plan.summary.label}${v.moveInDate ? `, move-in ${v.moveInDate}` : ""}${v.stayFrom ? `, ${v.stayFrom} → ${v.stayTo}` : ""}). Reply: ${appUrl(`/dashboard/enquiries/${e.id}`)}`,
      payload: { enquiryId: e.id },
    });
    await tx.insert(analyticsEvents).values({ name: "enquiry_submit", userId: renter.id, listingId: l.id, props: { planKey: plan.plan.planKey } });
    await writeAudit(tx, { actorUserId: renter.id, actorRole: "renter", action: "enquiry.created", subjectType: "listing", subjectId: l.id, data: { enquiryId: e.id, planKey: plan.plan.planKey, basePaise: plan.summary.basePaise } });
    return e;
  });
}

async function loadEnquiryFor(user: SessionUser, enquiryId: string) {
  const [row] = await db.select({ e: enquiries, l: listings }).from(enquiries).innerJoin(listings, eq(listings.id, enquiries.listingId)).where(eq(enquiries.id, enquiryId));
  if (!row) throw new DomainError("Enquiry not found", "not_found");
  const isRenter = row.e.renterUserId === user.id;
  const isLister = user.orgs.some((o) => o.id === row.l.orgId);
  const isAdmin = user.roles.includes("admin");
  if (!isRenter && !isLister && !isAdmin) throw new DomainError("Not your enquiry", "forbidden");
  return { ...row, role: (isLister ? "lister" : isRenter ? "renter" : "admin") as "lister" | "renter" | "admin" };
}

export async function getEnquiryThread(user: SessionUser, enquiryId: string) {
  const r = await loadEnquiryFor(user, enquiryId);
  const msgs = await db.select().from(enquiryMessages).where(eq(enquiryMessages.enquiryId, enquiryId)).orderBy(asc(enquiryMessages.createdAt));
  const vs = await db.select().from(visits).where(eq(visits.enquiryId, enquiryId)).orderBy(asc(visits.slotStart));
  const [renter] = await db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, r.e.renterUserId));
  const [outcome] = await db.select().from(rentalOutcomes).where(eq(rentalOutcomes.enquiryId, enquiryId));
  const [unit] = r.e.unitId ? await db.select().from(units).where(eq(units.id, r.e.unitId)) : [];
  // Renter's number is visible to the lister only because the renter enquired (consented contact).
  return {
    enquiry: r.e,
    listing: r.l,
    role: r.role,
    messages: msgs,
    visits: vs,
    outcome: outcome ?? null,
    unit: unit ?? null,
    renter: { name: renter?.name ?? "Renter", phone: r.role === "renter" ? renter.phone : renter ? maskPhone(renter.phone) : "" },
    renterPhoneFull: r.role !== "renter" ? renter?.phone : undefined,
  };
}

export async function postMessage(user: SessionUser, enquiryId: string, body: string) {
  const r = await loadEnquiryFor(user, enquiryId);
  const text = body.trim();
  if (!text) throw new DomainError("Message is empty");
  if (text.length > 1000) throw new DomainError("Message is too long");
  await db.transaction(async (tx) => {
    await tx.insert(enquiryMessages).values({ enquiryId, senderRole: r.role === "admin" ? "system" : r.role, senderUserId: user.id, body: text });
    if (r.role === "lister") {
      const patch: Partial<typeof enquiries.$inferInsert> = { updatedAt: new Date() };
      if (!r.e.firstResponseAt) patch.firstResponseAt = new Date();
      if (r.e.status === "new") patch.status = "responded";
      await tx.update(enquiries).set(patch).where(eq(enquiries.id, enquiryId));
      await queueNotification(tx, { userId: r.e.renterUserId, template: "lister_reply", body: `Reply about "${r.l.title}": ${text.slice(0, 140)} ${appUrl(`/me/enquiries/${enquiryId}`)}` });
    } else {
      await queueNotification(tx, { userId: r.l.listerUserId, template: "renter_message", body: `Message about "${r.l.title}": ${text.slice(0, 140)} ${appUrl(`/dashboard/enquiries/${enquiryId}`)}` });
    }
  });
}

export async function proposeVisits(user: SessionUser, enquiryId: string, slots: { start: string; mode: "in_person" | "video" }[]) {
  const r = await loadEnquiryFor(user, enquiryId);
  if (r.role !== "lister") throw new DomainError("Only the lister can propose visit slots", "forbidden");
  const clean = slots
    .map((s) => ({ start: new Date(s.start), mode: s.mode }))
    .filter((s) => !Number.isNaN(s.start.getTime()));
  if (!clean.length) throw new DomainError("Add at least one slot");
  if (clean.some((s) => s.start.getTime() < Date.now())) throw new DomainError("Slots must be in the future");
  await db.transaction(async (tx) => {
    for (const s of clean.slice(0, 5)) {
      await tx.insert(visits).values({ enquiryId, mode: s.mode, slotStart: s.start, slotEnd: new Date(s.start.getTime() + 30 * 60_000) });
    }
    if (!r.e.firstResponseAt) await tx.update(enquiries).set({ firstResponseAt: new Date(), status: r.e.status === "new" ? "responded" : r.e.status }).where(eq(enquiries.id, enquiryId));
    await tx.insert(enquiryMessages).values({ enquiryId, senderRole: "system", body: `Lister proposed ${clean.length} visit slot(s).` });
    await queueNotification(tx, { userId: r.e.renterUserId, template: "visit_slots", body: `Pick a visit slot for "${r.l.title}": ${appUrl(`/me/enquiries/${enquiryId}`)}` });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "visit.proposed", subjectType: "enquiry", subjectId: enquiryId, data: { slots: clean.length } });
  });
}

const VISIT_TRANSITIONS: Record<string, Record<string, ("renter" | "lister")[]>> = {
  proposed: { confirmed: ["renter"], cancelled: ["renter", "lister"] },
  confirmed: { completed: ["lister", "renter"], no_show_renter: ["lister"], no_show_lister: ["renter"], cancelled: ["renter", "lister"] },
};

export async function updateVisit(user: SessionUser, visitId: string, to: string) {
  const [v] = await db.select().from(visits).where(eq(visits.id, visitId));
  if (!v) throw new DomainError("Visit not found", "not_found");
  const r = await loadEnquiryFor(user, v.enquiryId);
  if (r.role === "admin") throw new DomainError("Admins cannot change visits", "forbidden");
  const allowed = VISIT_TRANSITIONS[v.status]?.[to];
  if (!allowed || !allowed.includes(r.role)) throw new DomainError(`Cannot change a ${v.status} visit to ${to}`, "conflict");
  await db.transaction(async (tx) => {
    await tx.update(visits).set({ status: to, updatedAt: new Date() }).where(eq(visits.id, visitId));
    if (to === "confirmed") {
      await tx
        .update(visits)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(visits.enquiryId, v.enquiryId), eq(visits.status, "proposed"), sql`${visits.id} <> ${visitId}`));
      await tx.update(enquiries).set({ status: "visit_scheduled", updatedAt: new Date() }).where(eq(enquiries.id, v.enquiryId));
    }
    const when = v.slotStart.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    await tx.insert(enquiryMessages).values({ enquiryId: v.enquiryId, senderRole: "system", body: `Visit on ${when} is now ${to.replace(/_/g, " ")}.` });
    const other = r.role === "renter" ? r.l.listerUserId : r.e.renterUserId;
    await queueNotification(tx, { userId: other, template: "visit_update", body: `Visit for "${r.l.title}" on ${when}: ${to.replace(/_/g, " ")}.` });
    await writeAudit(tx, { actorUserId: user.id, actorRole: r.role, action: `visit.${to}`, subjectType: "enquiry", subjectId: v.enquiryId, data: { visitId } });
  });
}

export const outcomeSchema = z.object({
  outcome: z.enum(["rented_here", "rented_elsewhere", "not_rented", "listing_unavailable", "misleading"]),
  finalRentRupees: z.coerce.number().min(0).max(1e7).optional().nullable(),
  brokeragePaidRupees: z.coerce.number().min(0).max(1e7).optional().nullable(),
});

export async function recordOutcome(user: SessionUser, enquiryId: string, input: z.input<typeof outcomeSchema>) {
  const r = await loadEnquiryFor(user, enquiryId);
  if (r.role === "admin") throw new DomainError("Admins cannot record outcomes", "forbidden");
  const v = outcomeSchema.parse(input);
  await db.transaction(async (tx) => {
    await tx
      .insert(rentalOutcomes)
      .values({
        enquiryId,
        outcome: v.outcome,
        reportedBy: r.role,
        finalRentPaise: v.finalRentRupees ? Math.round(v.finalRentRupees * 100) : null,
        brokeragePaidPaise: v.brokeragePaidRupees != null ? Math.round(v.brokeragePaidRupees * 100) : null,
      })
      .onConflictDoUpdate({ target: rentalOutcomes.enquiryId, set: { outcome: v.outcome, reportedBy: r.role, createdAt: new Date() } });
    const status = v.outcome === "rented_here" ? "closed_won" : "closed_lost";
    await tx.update(enquiries).set({ status, updatedAt: new Date() }).where(eq(enquiries.id, enquiryId));
    await writeAudit(tx, { actorUserId: user.id, actorRole: r.role, action: "outcome.recorded", subjectType: "listing", subjectId: r.l.id, data: { enquiryId, ...v } });
    if (v.outcome === "listing_unavailable" && r.role === "renter") await maybeAutoPauseForUnavailable(tx, r.l.id);
    // Brokerage paid above what was disclosed is a trust signal for moderators.
    const snap = r.e.priceSnapshot as { plan?: { brokeragePaise?: number | null } };
    if (v.brokeragePaidRupees != null && snap.plan?.brokeragePaise != null && v.brokeragePaidRupees * 100 > snap.plan.brokeragePaise + 100) {
      const { moderationCases } = await import("./schema");
      await tx.insert(moderationCases).values({
        kind: "dispute",
        listingId: r.l.id,
        priority: "fraud",
        subject: { reason: "brokerage_above_disclosed", enquiryId, disclosedPaise: snap.plan.brokeragePaise, paidPaise: v.brokeragePaidRupees * 100 },
        slaDueAt: new Date(Date.now() + 86400_000),
      });
    }
  });
}

export async function listerInbox(user: SessionUser) {
  const orgIds = user.orgs.map((o) => o.id);
  if (!orgIds.length) return [];
  return db
    .select({ enquiry: enquiries, listing: listings, renterName: users.name })
    .from(enquiries)
    .innerJoin(listings, eq(listings.id, enquiries.listingId))
    .innerJoin(users, eq(users.id, enquiries.renterUserId))
    .where(inArray(listings.orgId, orgIds))
    .orderBy(desc(enquiries.createdAt))
    .limit(200);
}

export async function renterEnquiries(user: SessionUser) {
  return db
    .select({ enquiry: enquiries, listing: listings })
    .from(enquiries)
    .innerJoin(listings, eq(listings.id, enquiries.listingId))
    .where(eq(enquiries.renterUserId, user.id))
    .orderBy(desc(enquiries.createdAt));
}

// ---------- hotel booking requests ----------

export async function quoteForListing(listingId: string, unitId: string, from: string, to: string, rooms = 1) {
  const plans = await currentPlans(listingId);
  const plan = plans.find((p) => p.plan.unitId === unitId);
  if (!plan) throw new DomainError("Room type not offered in this listing", "not_found");
  const inv = await db
    .select()
    .from(nightlyInventory)
    .where(and(eq(nightlyInventory.unitId, unitId), gte(nightlyInventory.date, from), lte(nightlyInventory.date, to)));
  return {
    plan: plan.summary,
    quote: quoteStay(
      inv.map((r) => ({ date: r.date, ratePaise: r.ratePaise, availableCount: r.availableCount, minStay: r.minStay, closedToArrival: r.closedToArrival })),
      from,
      to,
      plan.input.charges,
      rooms,
    ),
  };
}

export async function createBookingRequest(renter: SessionUser, input: { listingId: string; unitId: string; from: string; to: string; guests: number }) {
  const [l] = await db.select().from(listings).where(eq(listings.id, input.listingId));
  if (!l || l.status !== "published" || l.category !== "short_stay") throw new DomainError("This hotel is not accepting requests", "conflict");
  const [lu] = await db.select().from(listingUnits).where(and(eq(listingUnits.listingId, l.id), eq(listingUnits.unitId, input.unitId)));
  if (!lu) throw new DomainError("Room type not offered", "not_found");
  const [u] = await db.select().from(units).where(eq(units.id, input.unitId));
  if (input.guests > (u.maxOccupancy ?? 2)) throw new DomainError(`Maximum ${u.maxOccupancy} guests for this room`);
  if (input.from < todayIST()) throw new DomainError("Check-in cannot be in the past");
  const { quote } = await quoteForListing(l.id, input.unitId, input.from, input.to);
  if (!quote.available) throw new DomainError(quote.reason ?? "Not available for these dates", "conflict");
  return db.transaction(async (tx) => {
    const [b] = await tx
      .insert(bookings)
      .values({ listingId: l.id, unitId: input.unitId, renterUserId: renter.id, stayFrom: input.from, stayTo: input.to, guests: input.guests, quote })
      .returning();
    await queueNotification(tx, {
      userId: l.listerUserId,
      template: "booking_request",
      body: `Booking request: ${u.label}, ${input.from} → ${input.to}, ${input.guests} guest(s), total ${formatINR(quote.totalPaise)}. Confirm: ${appUrl("/dashboard/enquiries")}`,
    });
    await writeAudit(tx, { actorUserId: renter.id, actorRole: "renter", action: "booking.requested", subjectType: "listing", subjectId: l.id, data: { bookingId: b.id, totalPaise: quote.totalPaise } });
    return b;
  });
}

/** Confirming decrements nightly inventory atomically; fails if any night sold out meanwhile. */
export async function decideBooking(user: SessionUser, bookingId: string, decision: "confirmed" | "declined") {
  const [row] = await db.select({ b: bookings, l: listings }).from(bookings).innerJoin(listings, eq(listings.id, bookings.listingId)).where(eq(bookings.id, bookingId));
  if (!row) throw new DomainError("Booking not found", "not_found");
  if (!user.orgs.some((o) => o.id === row.l.orgId)) throw new DomainError("Not your hotel", "forbidden");
  if (row.b.status !== "requested") throw new DomainError(`Booking is already ${row.b.status}`, "conflict");
  await db.transaction(async (tx) => {
    if (decision === "confirmed") {
      const nights = await tx
        .select()
        .from(nightlyInventory)
        .where(and(eq(nightlyInventory.unitId, row.b.unitId), gte(nightlyInventory.date, row.b.stayFrom), sql`${nightlyInventory.date} < ${row.b.stayTo}`))
        .for("update");
      const expected = Math.round((new Date(row.b.stayTo).getTime() - new Date(row.b.stayFrom).getTime()) / 86400_000);
      if (nights.length !== expected || nights.some((n) => n.availableCount < 1)) throw new DomainError("Sold out on some nights: decline or adjust inventory", "conflict");
      await tx
        .update(nightlyInventory)
        .set({ availableCount: sql`${nightlyInventory.availableCount} - 1`, syncedAt: new Date() })
        .where(and(eq(nightlyInventory.unitId, row.b.unitId), gte(nightlyInventory.date, row.b.stayFrom), sql`${nightlyInventory.date} < ${row.b.stayTo}`));
    }
    await tx.update(bookings).set({ status: decision }).where(eq(bookings.id, bookingId));
    await queueNotification(tx, { userId: row.b.renterUserId, template: "booking_decision", body: `Your request at "${row.l.title}" (${row.b.stayFrom} → ${row.b.stayTo}) was ${decision}.` });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: `booking.${decision}`, subjectType: "listing", subjectId: row.l.id, data: { bookingId } });
  });
}

export async function listerBookings(user: SessionUser) {
  const orgIds = user.orgs.map((o) => o.id);
  if (!orgIds.length) return [];
  return db
    .select({ booking: bookings, listing: listings, unit: units, renterName: users.name })
    .from(bookings)
    .innerJoin(listings, eq(listings.id, bookings.listingId))
    .innerJoin(units, eq(units.id, bookings.unitId))
    .innerJoin(users, eq(users.id, bookings.renterUserId))
    .where(inArray(listings.orgId, orgIds))
    .orderBy(desc(bookings.createdAt));
}

export async function renterBookings(user: SessionUser) {
  return db
    .select({ booking: bookings, listing: listings, unit: units })
    .from(bookings)
    .innerJoin(listings, eq(listings.id, bookings.listingId))
    .innerJoin(units, eq(units.id, bookings.unitId))
    .where(eq(bookings.renterUserId, user.id))
    .orderBy(desc(bookings.createdAt));
}
