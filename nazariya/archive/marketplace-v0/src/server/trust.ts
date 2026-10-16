// Trust module: verification checks, authorisations, badges, duplicates, reports, moderation, freshness.
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { deriveBadges, type CheckLike } from "@/lib/badges";
import { CHECK_TYPES } from "@/lib/catalog";
import { dedupeScore, hammingHex, haversineMeters, isStolenPhotoPattern, trigramSimilarity } from "@/lib/dedupe";
import { FRESHNESS_RULES, freshnessState, type ListingCategory } from "@/lib/freshness";
import { writeAudit } from "./audit";
import { normalizePhone, requestOtp, verifyOtp, type SessionUser } from "./auth";
import { db, type Exec } from "./db";
import { DomainError } from "./errors";
import { appUrl, queueNotification } from "./notify";
import {
  captureSessions,
  dedupeCandidates,
  listings,
  mediaAssets,
  moderationCases,
  moderationDecisions,
  notifications,
  ownerContacts,
  properties,
  propertyAuthorizations,
  reports,
  users,
  verificationChecks,
  verificationEvidence,
} from "./schema";

const DAY = 86400_000;

function expiryFor(checkType: string): Date {
  const days = CHECK_TYPES[checkType]?.validityDays ?? 365;
  return new Date(Date.now() + days * DAY);
}

export async function addCheck(
  exec: Exec,
  c: {
    subjectType: string;
    subjectId: string;
    checkType: string;
    status: "pending" | "passed" | "failed" | "needs_review";
    method: "automated" | "provider" | "manual";
    provider?: string;
    providerRef?: string;
    data?: Record<string, unknown>;
    reason?: string;
    decidedBy?: string | null;
    actorRole?: string;
    expiresAt?: Date;
  },
) {
  const decided = c.status === "passed" || c.status === "failed";
  const [row] = await exec
    .insert(verificationChecks)
    .values({
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      checkType: c.checkType,
      status: c.status,
      method: c.method,
      provider: c.provider,
      providerRef: c.providerRef,
      data: c.data ?? {},
      reason: c.reason,
      decidedBy: c.decidedBy ?? null,
      decidedAt: decided ? new Date() : null,
      expiresAt: c.status === "passed" ? (c.expiresAt ?? expiryFor(c.checkType)) : null,
    })
    .returning();
  await writeAudit(exec, {
    actorUserId: c.decidedBy ?? null,
    actorRole: c.actorRole ?? (c.method === "manual" ? "admin" : "system"),
    action: `check.${c.status}`,
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    data: { checkId: row.id, checkType: c.checkType, method: c.method, provider: c.provider ?? null, reason: c.reason ?? null },
  });
  return row;
}

// ---------- broker identity (sandbox providers; production uses a licensed KYC aggregator) ----------

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function maskPan(pan: string): string {
  return pan.slice(0, 5) + "****" + pan.slice(9);
}

/** Sandbox PAN check: validates format and name match. Never stores the full PAN. */
export async function verifyPan(user: SessionUser, panRaw: string, nameOnPan: string) {
  const pan = panRaw.trim().toUpperCase();
  if (!PAN_RE.test(pan)) throw new DomainError("PAN must look like ABCDE1234F");
  if (!nameOnPan.trim()) throw new DomainError("Enter the name exactly as printed on the PAN card");
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, user.id));
    if (!u.name) await tx.update(users).set({ name: nameOnPan.trim() }).where(eq(users.id, user.id));
    const profileName = (u.name ?? nameOnPan).toLowerCase().replace(/\s+/g, " ").trim();
    const match = trigramSimilarity(profileName, nameOnPan.toLowerCase().trim()) >= 0.5;
    return addCheck(tx, {
      subjectType: "user",
      subjectId: user.id,
      checkType: "pan_verified",
      status: match ? "passed" : "needs_review",
      method: "provider",
      provider: "kyc_sandbox",
      providerRef: `sbx_${Date.now().toString(36)}`,
      data: { panMasked: maskPan(pan), nameOnPan: nameOnPan.trim() },
      reason: match ? undefined : "Name on PAN does not match profile name",
      decidedBy: null,
      actorRole: "system",
    });
  });
}

/** Sandbox DigiLocker consent flow. Stores only a masked reference, never an Aadhaar number. */
export async function verifyDigilocker(user: SessionUser, consent: boolean) {
  if (!consent) throw new DomainError("Consent is required to fetch your ID from DigiLocker");
  return db.transaction((tx) =>
    addCheck(tx, {
      subjectType: "user",
      subjectId: user.id,
      checkType: "identity_digilocker",
      status: "passed",
      method: "provider",
      provider: "digilocker_sandbox",
      providerRef: `dl_${Date.now().toString(36)}`,
      data: { document: "Government ID (sandbox)", reference: "masked" },
    }),
  );
}

export async function submitRera(user: SessionUser, reraNo: string) {
  const v = reraNo.trim().toUpperCase();
  if (!/^[A-Z0-9/\-]{6,40}$/.test(v)) throw new DomainError("Enter the registration number as shown on your RERA certificate");
  return db.transaction((tx) =>
    addCheck(tx, {
      subjectType: "user",
      subjectId: user.id,
      checkType: "rera_agent_registration",
      status: "needs_review",
      method: "manual",
      data: { reraNo: v },
      actorRole: "lister",
      decidedBy: null,
    }),
  );
}

export async function checksFor(subjectType: string, subjectIds: string[], exec: Exec = db) {
  if (!subjectIds.length) return [];
  return exec
    .select()
    .from(verificationChecks)
    .where(and(eq(verificationChecks.subjectType, subjectType), inArray(verificationChecks.subjectId, subjectIds)))
    .orderBy(desc(verificationChecks.createdAt));
}

export async function decideCheck(admin: SessionUser, checkId: string, decision: "passed" | "failed", reason: string) {
  if (!admin.roles.includes("admin")) throw new DomainError("Admins only", "forbidden");
  if (decision === "failed" && !reason.trim()) throw new DomainError("A reason is required to reject a check");
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(verificationChecks).where(eq(verificationChecks.id, checkId)).for("update");
    if (!c) throw new DomainError("Check not found", "not_found");
    if (!["pending", "needs_review"].includes(c.status)) throw new DomainError("This check was already decided", "conflict");
    await tx
      .update(verificationChecks)
      .set({
        status: decision,
        decidedBy: admin.id,
        decidedAt: new Date(),
        reason: reason || null,
        expiresAt: decision === "passed" ? expiryFor(c.checkType) : null,
      })
      .where(eq(verificationChecks.id, checkId));
    await writeAudit(tx, {
      actorUserId: admin.id,
      actorRole: "admin",
      action: `check.${decision}`,
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      data: { checkId, checkType: c.checkType, reason },
    });
    if (c.subjectType === "authorization") await refreshAuthorizationStatus(tx, c.subjectId);
    if (c.subjectType === "user" && c.checkType === "rera_agent_registration" && decision === "passed") {
      // nothing else to update; badge derivation reads checks directly
    }
  });
}

export async function revokeCheck(admin: SessionUser, checkId: string, reason: string) {
  if (!admin.roles.includes("admin")) throw new DomainError("Admins only", "forbidden");
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(verificationChecks).where(eq(verificationChecks.id, checkId));
    if (!c) throw new DomainError("Check not found", "not_found");
    await tx.update(verificationChecks).set({ status: "revoked", reason, decidedBy: admin.id, decidedAt: new Date() }).where(eq(verificationChecks.id, checkId));
    await writeAudit(tx, { actorUserId: admin.id, actorRole: "admin", action: "check.revoked", subjectType: c.subjectType, subjectId: c.subjectId, data: { checkId, reason } });
    if (c.subjectType === "authorization") await refreshAuthorizationStatus(tx, c.subjectId);
  });
}

// ---------- authorisations ----------

/** An authorisation becomes active once the owner/operator has confirmed by phone. */
export async function refreshAuthorizationStatus(exec: Exec, authorizationId: string) {
  const checks = await checksFor("authorization", [authorizationId], exec);
  const now = new Date();
  const confirmed = checks.some((c) => c.checkType === "owner_contact_confirmation" && c.status === "passed" && (!c.expiresAt || c.expiresAt > now));
  const [a] = await exec.select().from(propertyAuthorizations).where(eq(propertyAuthorizations.id, authorizationId));
  if (!a || a.status === "revoked") return;
  const next = confirmed ? "active" : "pending";
  if (a.status !== next) {
    await exec.update(propertyAuthorizations).set({ status: next }).where(eq(propertyAuthorizations.id, authorizationId));
    await writeAudit(exec, { actorUserId: null, actorRole: "system", action: `authorization.${next}`, subjectType: "authorization", subjectId: authorizationId });
  }
}

export async function requestOwnerConfirmation(user: SessionUser, authorizationId: string) {
  const [a] = await db
    .select({ auth: propertyAuthorizations, owner: ownerContacts, property: properties })
    .from(propertyAuthorizations)
    .innerJoin(properties, eq(properties.id, propertyAuthorizations.propertyId))
    .leftJoin(ownerContacts, eq(ownerContacts.id, propertyAuthorizations.ownerContactId))
    .where(eq(propertyAuthorizations.id, authorizationId));
  if (!a) throw new DomainError("Authorisation not found", "not_found");
  if (!user.orgs.some((o) => o.id === a.auth.orgId)) throw new DomainError("Not your authorisation", "forbidden");
  if (!a.owner) throw new DomainError("Add the owner's contact first");
  await db.transaction(async (tx) => {
    await queueNotification(tx, {
      toPhone: a.owner!.phone,
      channel: "whatsapp",
      template: "owner_confirmation_request",
      body: `Namaste ${a.owner!.name}, a lister has asked to market "${a.property.name ?? a.property.addressLine}" on Nazariya. Please confirm or decline: ${appUrl(`/confirm/owner/${authorizationId}`)}`,
      payload: { authorizationId },
    });
    await writeAudit(tx, { actorUserId: user.id, actorRole: "lister", action: "authorization.owner_confirmation_requested", subjectType: "authorization", subjectId: authorizationId });
  });
}

export async function getAuthorizationForOwner(authorizationId: string) {
  const [a] = await db
    .select({ auth: propertyAuthorizations, owner: ownerContacts, property: properties })
    .from(propertyAuthorizations)
    .innerJoin(properties, eq(properties.id, propertyAuthorizations.propertyId))
    .leftJoin(ownerContacts, eq(ownerContacts.id, propertyAuthorizations.ownerContactId))
    .where(eq(propertyAuthorizations.id, authorizationId));
  if (!a || !a.owner) return null;
  const { organizations } = await import("./schema");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, a.auth.orgId));
  return { ...a, org };
}

export async function sendOwnerOtp(authorizationId: string) {
  const a = await getAuthorizationForOwner(authorizationId);
  if (!a) throw new DomainError("Not found", "not_found");
  return requestOtp(a.owner!.phone, "owner_confirmation", { authorizationId });
}

export async function ownerRespond(authorizationId: string, code: string, accept: boolean) {
  const a = await getAuthorizationForOwner(authorizationId);
  if (!a) throw new DomainError("Not found", "not_found");
  const { phone, context } = await verifyOtp(a.owner!.phone, code, "owner_confirmation");
  if (context.authorizationId !== authorizationId) throw new DomainError("This code was issued for a different request");
  await db.transaction(async (tx) => {
    await tx.update(ownerContacts).set({ consentAt: new Date() }).where(eq(ownerContacts.id, a.owner!.id));
    await addCheck(tx, {
      subjectType: "authorization",
      subjectId: authorizationId,
      checkType: "owner_contact_confirmation",
      status: accept ? "passed" : "failed",
      method: "automated",
      data: { ownerPhoneMasked: phone.replace(/\d(?=\d{3})/g, "x"), via: "otp" },
      reason: accept ? undefined : "Owner declined",
      actorRole: "owner",
    });
    if (!accept) {
      await tx.update(propertyAuthorizations).set({ status: "rejected" }).where(eq(propertyAuthorizations.id, authorizationId));
      // Any listing relying on a rejected authorisation is paused immediately.
      const affected = await tx.select({ id: listings.id }).from(listings).where(and(eq(listings.authorizationId, authorizationId), inArray(listings.status, ["published", "stale"])));
      for (const l of affected) {
        await tx.update(listings).set({ status: "paused", updatedAt: new Date() }).where(eq(listings.id, l.id));
        await writeAudit(tx, { actorUserId: null, actorRole: "owner", action: "listing.paused", subjectType: "listing", subjectId: l.id, data: { reason: "owner_declined" } });
      }
    } else {
      await refreshAuthorizationStatus(tx, authorizationId);
    }
  });
}

export async function submitAuthorizationDocument(
  user: SessionUser,
  authorizationId: string,
  checkType: "ownership_document" | "operator_lease" | "hotel_registration",
  file: { key: string; sha256: string; note?: string },
) {
  const [a] = await db.select().from(propertyAuthorizations).where(eq(propertyAuthorizations.id, authorizationId));
  if (!a || !user.orgs.some((o) => o.id === a.orgId)) throw new DomainError("Not your authorisation", "forbidden");
  return db.transaction(async (tx) => {
    const check = await addCheck(tx, {
      subjectType: "authorization",
      subjectId: authorizationId,
      checkType,
      status: "needs_review",
      method: "manual",
      actorRole: "lister",
      decidedBy: null,
    });
    await tx.insert(verificationEvidence).values({ checkId: check.id, kind: "document_image", storageKey: file.key, sha256: file.sha256, note: file.note });
    return check;
  });
}

// ---------- badges ----------

export async function badgesForListing(listing: { id: string; listerUserId: string; authorizationId: string | null }, now = new Date()) {
  const [userChecks, authChecks, listingChecks] = await Promise.all([
    checksFor("user", [listing.listerUserId]),
    listing.authorizationId ? checksFor("authorization", [listing.authorizationId]) : Promise.resolve([]),
    checksFor("listing", [listing.id]),
  ]);
  const all: CheckLike[] = [...userChecks, ...authChecks, ...listingChecks];
  return { badges: deriveBadges(all, now), checks: [...userChecks, ...authChecks, ...listingChecks] };
}

/** Bulk variant for search results. */
export async function badgesForListings(rows: { id: string; listerUserId: string; authorizationId: string | null }[], now = new Date()) {
  const [u, a, l] = await Promise.all([
    checksFor("user", [...new Set(rows.map((r) => r.listerUserId))]),
    checksFor("authorization", rows.map((r) => r.authorizationId).filter((x): x is string => !!x)),
    checksFor("listing", rows.map((r) => r.id)),
  ]);
  const out = new Map<string, ReturnType<typeof deriveBadges>>();
  for (const r of rows) {
    const checks = [
      ...u.filter((c) => c.subjectId === r.listerUserId),
      ...a.filter((c) => c.subjectId === r.authorizationId),
      ...l.filter((c) => c.subjectId === r.id),
    ];
    out.set(r.id, deriveBadges(checks, now));
  }
  return out;
}

// ---------- on-site capture check ----------

export async function runOnsiteCheck(listingId: string) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l) return;
  const [p] = await db.select().from(properties).where(eq(properties.id, l.propertyId));
  const media = await db
    .select({ asset: mediaAssets, session: captureSessions })
    .from(mediaAssets)
    .leftJoin(captureSessions, eq(captureSessions.id, mediaAssets.captureSessionId))
    .where(and(eq(mediaAssets.propertyId, l.propertyId), inArray(mediaAssets.kind, ["photo", "pano"]), eq(mediaAssets.status, "ready")));
  if (!media.length) return;
  const cutoff = Date.now() - 90 * DAY;
  const bad = media.filter(
    (m) =>
      !m.session ||
      !m.session.inApp ||
      m.session.lat == null ||
      m.session.lng == null ||
      haversineMeters(m.session.lat, m.session.lng, p.lat, p.lng) > 150 ||
      m.asset.createdAt.getTime() < cutoff,
  );
  const passed = bad.length === 0;
  await db.transaction(async (tx) => {
    // Supersede earlier automated results so the latest capture state wins.
    await tx
      .update(verificationChecks)
      .set({ status: "expired" })
      .where(and(eq(verificationChecks.subjectType, "listing"), eq(verificationChecks.subjectId, listingId), eq(verificationChecks.checkType, "onsite_capture_consistency"), eq(verificationChecks.status, "passed")));
    await addCheck(tx, {
      subjectType: "listing",
      subjectId: listingId,
      checkType: "onsite_capture_consistency",
      status: passed ? "passed" : "failed",
      method: "automated",
      data: { mediaChecked: media.length, failing: bad.length },
      reason: passed ? undefined : `${bad.length} item(s) were uploaded from the gallery or captured away from the property`,
    });
  });
}

// ---------- duplicate detection ----------

export async function runDedupeForProperty(propertyId: string) {
  const [p] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!p) return [];
  const dLat = 300 / 111_000;
  const dLng = 300 / (111_000 * Math.cos((p.lat * Math.PI) / 180));
  const near = await db
    .select()
    .from(properties)
    .where(
      and(
        ne(properties.id, propertyId),
        or(
          and(sql`${properties.lat} between ${p.lat - dLat} and ${p.lat + dLat}`, sql`${properties.lng} between ${p.lng - dLng} and ${p.lng + dLng}`),
          sql`similarity(${properties.normalizedAddress}, ${p.normalizedAddress}) > 0.45`,
        ),
      ),
    );
  // Photos of this property vs. ANY other property (stolen photos can be anywhere).
  const mine = await db.select({ dhash: mediaAssets.dhash }).from(mediaAssets).where(and(eq(mediaAssets.propertyId, propertyId), sql`${mediaAssets.dhash} is not null`));
  const mineHashes = mine.map((m) => m.dhash!).filter(Boolean);
  const photoMatches = new Map<string, number>();
  if (mineHashes.length) {
    const others = await db
      .select({ propertyId: mediaAssets.propertyId, dhash: mediaAssets.dhash })
      .from(mediaAssets)
      .where(and(ne(mediaAssets.propertyId, propertyId), sql`${mediaAssets.dhash} is not null`));
    for (const o of others) {
      if (!o.propertyId) continue;
      if (mineHashes.some((h) => hammingHex(h, o.dhash!) <= 8)) photoMatches.set(o.propertyId, (photoMatches.get(o.propertyId) ?? 0) + 1);
    }
  }
  const candidateIds = new Set([...near.map((n) => n.id), ...photoMatches.keys()]);
  const results: { otherId: string; score: number; stolen: boolean }[] = [];
  const ownerPhones = await db.select().from(ownerContacts).where(inArray(ownerContacts.propertyId, [propertyId, ...candidateIds]));
  for (const otherId of candidateIds) {
    const [o] = near.find((n) => n.id === otherId) ? [near.find((n) => n.id === otherId)!] : await db.select().from(properties).where(eq(properties.id, otherId));
    if (!o) continue;
    const myPhones = new Set(ownerPhones.filter((x) => x.propertyId === propertyId).map((x) => x.phone));
    const signals = {
      distanceM: Math.round(haversineMeters(p.lat, p.lng, o.lat, o.lng)),
      addressSimilarity: Math.round(trigramSimilarity(p.normalizedAddress, o.normalizedAddress) * 1000) / 1000,
      samePhoneHash: ownerPhones.some((x) => x.propertyId === otherId && myPhones.has(x.phone)),
      sharedPhotos: photoMatches.get(otherId) ?? 0,
    };
    const score = dedupeScore(signals);
    const stolen = isStolenPhotoPattern(signals);
    if (score < 0.5 && !stolen) continue;
    const [a, b] = [propertyId, otherId].sort();
    await db.transaction(async (tx) => {
      const existing = await tx.select().from(dedupeCandidates).where(and(eq(dedupeCandidates.propertyA, a), eq(dedupeCandidates.propertyB, b)));
      if (existing.length) {
        await tx.update(dedupeCandidates).set({ score, signals }).where(eq(dedupeCandidates.id, existing[0].id));
        return;
      }
      const [cs] = await tx
        .insert(moderationCases)
        .values({
          kind: "duplicate",
          priority: stolen ? "fraud" : "normal",
          subject: { propertyA: a, propertyB: b, score, signals, stolenPhotoPattern: stolen },
          slaDueAt: new Date(Date.now() + (stolen ? 1 : 3) * DAY),
        })
        .returning();
      await tx.insert(dedupeCandidates).values({ propertyA: a, propertyB: b, score, signals, caseId: cs.id });
      await writeAudit(tx, { actorUserId: null, actorRole: "system", action: "dedupe.candidate", subjectType: "property", subjectId: propertyId, data: { otherId, score, stolen } });
    });
    results.push({ otherId, score, stolen });
  }
  return results;
}

// ---------- reports & moderation ----------

const PRIORITY: Record<string, "safety" | "fraud" | "normal"> = {
  safety: "safety",
  discrimination: "safety",
  fake_photos: "fraud",
  unauthorised_listing: "fraud",
  hidden_charges: "fraud",
  broker_misconduct: "fraud",
};

export async function createReport(reporter: SessionUser | null, listingId: string, reason: string, details: string) {
  const [l] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!l) throw new DomainError("Listing not found", "not_found");
  const priority = PRIORITY[reason] ?? "normal";
  const slaHours = priority === "safety" ? 4 : priority === "fraud" ? 24 : 72;
  return db.transaction(async (tx) => {
    const [cs] = await tx
      .insert(moderationCases)
      .values({ kind: "report", listingId, priority, subject: { reason }, slaDueAt: new Date(Date.now() + slaHours * 3600_000) })
      .returning();
    const [r] = await tx
      .insert(reports)
      .values({ listingId, reporterUserId: reporter?.id ?? null, reason, details: details.slice(0, 2000), caseId: cs.id })
      .returning();
    await writeAudit(tx, { actorUserId: reporter?.id ?? null, actorRole: "renter", action: "report.created", subjectType: "listing", subjectId: listingId, data: { reason, reportId: r.id } });
    if (reason === "not_available") await maybeAutoPauseForUnavailable(tx, listingId);
    await queueNotification(tx, {
      userId: l.listerUserId,
      template: "listing_reported",
      body: `A renter reported your listing "${l.title}" (${reason.replace(/_/g, " ")}). Please review and reconfirm: ${appUrl(`/dashboard/listings/${l.id}`)}`,
    });
    return r;
  });
}

/** Two independent "not available" signals within 72h pause a listing until the lister reconfirms. */
export async function maybeAutoPauseForUnavailable(tx: Exec, listingId: string) {
  const since = new Date(Date.now() - 72 * 3600_000);
  const rows = await tx
    .select({ reporter: reports.reporterUserId })
    .from(reports)
    .where(and(eq(reports.listingId, listingId), eq(reports.reason, "not_available"), gte(reports.createdAt, since)));
  const { rentalOutcomes, enquiries } = await import("./schema");
  const outcomes = await tx
    .select({ reporter: enquiries.renterUserId })
    .from(rentalOutcomes)
    .innerJoin(enquiries, eq(enquiries.id, rentalOutcomes.enquiryId))
    .where(and(eq(enquiries.listingId, listingId), eq(rentalOutcomes.outcome, "listing_unavailable"), gte(rentalOutcomes.createdAt, since)));
  const distinct = new Set([...rows, ...outcomes].map((r) => r.reporter ?? "anon-" + Math.random()));
  if (distinct.size >= 2) {
    const [l] = await tx.select().from(listings).where(eq(listings.id, listingId));
    if (l && (l.status === "published" || l.status === "stale")) {
      await tx.update(listings).set({ status: "paused", updatedAt: new Date() }).where(eq(listings.id, listingId));
      await writeAudit(tx, { actorUserId: null, actorRole: "system", action: "listing.auto_paused", subjectType: "listing", subjectId: listingId, data: { reason: "multiple_unavailable_reports", count: distinct.size } });
      await queueNotification(tx, {
        userId: l.listerUserId,
        template: "listing_auto_paused",
        body: `Your listing "${l.title}" was paused because renters reported it is no longer available. Reconfirm availability to resume: ${appUrl(`/dashboard/listings/${l.id}`)}`,
      });
    }
  }
}

export type CaseDecision = "no_action" | "edit_required" | "suspend_listing" | "restore_listing" | "link_same_property" | "mark_different";

export async function decideCase(admin: SessionUser, caseId: string, decision: CaseDecision, rationale: string) {
  if (!admin.roles.includes("admin")) throw new DomainError("Admins only", "forbidden");
  if (!rationale.trim()) throw new DomainError("A rationale is required");
  await db.transaction(async (tx) => {
    const [cs] = await tx.select().from(moderationCases).where(eq(moderationCases.id, caseId)).for("update");
    if (!cs) throw new DomainError("Case not found", "not_found");
    await tx.insert(moderationDecisions).values({ caseId, decision, rationale, decidedBy: admin.id });
    if (cs.listingId && (decision === "suspend_listing" || decision === "restore_listing")) {
      const status = decision === "suspend_listing" ? "suspended" : "published";
      await tx.update(listings).set({ status, updatedAt: new Date() }).where(eq(listings.id, cs.listingId));
      await writeAudit(tx, { actorUserId: admin.id, actorRole: "admin", action: `listing.${status}`, subjectType: "listing", subjectId: cs.listingId, data: { caseId, rationale } });
      const [l] = await tx.select().from(listings).where(eq(listings.id, cs.listingId));
      await queueNotification(tx, { userId: l.listerUserId, template: "moderation_decision", body: `Moderation decision on "${l.title}": ${decision.replace(/_/g, " ")}. Reason: ${rationale}` });
    }
    if (cs.kind === "duplicate" && (decision === "link_same_property" || decision === "mark_different")) {
      const subj = cs.subject as { propertyA: string; propertyB: string };
      await tx
        .update(dedupeCandidates)
        .set({ status: decision === "link_same_property" ? "same_property" : "different" })
        .where(eq(dedupeCandidates.caseId, caseId));
      if (decision === "link_same_property") {
        const cluster = subj.propertyA; // deterministic cluster id
        await tx.update(properties).set({ dedupeClusterId: cluster }).where(inArray(properties.id, [subj.propertyA, subj.propertyB]));
      }
    }
    await tx.update(moderationCases).set({ status: "decided", updatedAt: new Date() }).where(eq(moderationCases.id, caseId));
    await tx.update(reports).set({ status: "decided" }).where(eq(reports.caseId, caseId));
    await writeAudit(tx, { actorUserId: admin.id, actorRole: "admin", action: "case.decided", subjectType: "case", subjectId: caseId, data: { decision, rationale } });
  });
}

// ---------- freshness ----------

/** Move listings between published → stale → expired; send reminders. Safe to run repeatedly. */
export async function freshnessSweep(now = new Date()) {
  const rows = await db.select().from(listings).where(inArray(listings.status, ["published", "stale"]));
  const changes: { id: string; from: string; to: string }[] = [];
  for (const l of rows) {
    const state = freshnessState(l.category as ListingCategory, l.lastConfirmedAt, now);
    let to = l.status;
    if (state === "expired") to = "expired";
    else if (state === "stale" || state === "never_confirmed") to = "stale";
    else if (l.status === "stale") to = "published";
    if (to !== l.status) {
      await db.transaction(async (tx) => {
        await tx.update(listings).set({ status: to, updatedAt: now }).where(eq(listings.id, l.id));
        await writeAudit(tx, { actorUserId: null, actorRole: "system", action: `listing.${to}`, subjectType: "listing", subjectId: l.id, data: { freshness: state } });
        await queueNotification(tx, {
          userId: l.listerUserId,
          template: to === "expired" ? "listing_expired" : "reconfirm_availability",
          body:
            to === "expired"
              ? `"${l.title}" has expired because availability was not confirmed. Relist any time: ${appUrl(`/dashboard/listings/${l.id}`)}`
              : `Is "${l.title}" still available? It is hidden from search until you confirm. Reply YES or tap: ${appUrl(`/dashboard/listings/${l.id}#availability`)}`,
          payload: { listingId: l.id, quickReplies: ["YES", "UPDATE", "RENTED OUT"] },
        });
      });
      changes.push({ id: l.id, from: l.status, to });
    } else if (state === "due_soon") {
      const rule = FRESHNESS_RULES[l.category as ListingCategory];
      const recent = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.template, "reconfirm_reminder"), sql`${notifications.payload}->>'listingId' = ${l.id}`, gte(notifications.createdAt, new Date(now.getTime() - rule.cadenceDays * 0.3 * DAY))));
      if (!recent.length) {
        await queueNotification(db, {
          userId: l.listerUserId,
          template: "reconfirm_reminder",
          body: `Quick check: is "${l.title}" still available? Confirm in one tap: ${appUrl(`/dashboard/listings/${l.id}#availability`)}`,
          payload: { listingId: l.id },
        });
      }
    }
  }
  return changes;
}

export function normalizeOwnerPhone(p: string) {
  return normalizePhone(p);
}
