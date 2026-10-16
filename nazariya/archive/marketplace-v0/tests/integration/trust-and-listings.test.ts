import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain, writeAudit } from "@/server/audit";
import { AuthError, loginWithOtp, requestOtp, userFromToken, verifyOtp } from "@/server/auth";
import { closeDb, db, getSql } from "@/server/db";
import { createBookingRequest, createEnquiry, decideBooking, getEnquiryThread, proposeVisits, recordOutcome, updateVisit } from "@/server/enquiries";
import { DomainError, rootMessage } from "@/server/errors";
import { claimJobs, enqueue } from "@/server/jobs";
import * as L from "@/server/listings";
import { handleUpload } from "@/server/media";
import { processPano } from "@/server/pipeline/process";
import { auditEvents, charges, dedupeCandidates, jobs, listings, mediaAssets, moderationCases, nightlyInventory, pricePlans, units, verificationChecks } from "@/server/schema";
import { badgesForListing, createReport, decideCase, decideCheck, freshnessSweep, runDedupeForProperty, submitAuthorizationDocument, verifyDigilocker, verifyPan } from "@/server/trust";
import { addDays, confirmOwner, drainJobs, ensureLocalities, makeAdmin, makeFlatListing, makeLister, makeUser, noiseJpeg, randomPhone, reloadListing, today } from "./fixtures";

beforeAll(async () => {
  await ensureLocalities();
});
afterAll(async () => {
  await closeDb();
});

const expectDbError = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toSatisfy((e: unknown) => re.test(rootMessage(e)));
};

const expectDomain = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && re.test(`${e.message} ${e.details.join(" ")}`));
};

describe("OTP authentication", () => {
  it("logs in with the right code and creates a session", async () => {
    const phone = randomPhone();
    const { devCode } = await requestOtp(phone);
    const { token, user } = await loginWithOtp(phone, devCode!);
    expect(user.phone).toBe(phone);
    expect((await userFromToken(token))?.id).toBe(user.id);
    const [phoneCheck] = await db.select().from(verificationChecks).where(and(eq(verificationChecks.subjectId, user.id), eq(verificationChecks.checkType, "phone_otp")));
    expect(phoneCheck.status).toBe("passed");
  });
  it("rejects wrong codes and locks after too many attempts", async () => {
    const phone = randomPhone();
    const { devCode } = await requestOtp(phone);
    const wrong = devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyOtp(phone, wrong)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyOtp(phone, devCode!)).rejects.toMatchObject({ code: "too_many_attempts" });
  });
  it("codes are single-use", async () => {
    const phone = randomPhone();
    const { devCode } = await requestOtp(phone);
    await verifyOtp(phone, devCode!);
    await expect(verifyOtp(phone, devCode!)).rejects.toBeInstanceOf(AuthError);
  });
});

describe("publishing rules", () => {
  it("blocks publishing until the owner confirms, then publishes", async () => {
    const { lister, listing, authorizationId } = await makeFlatListing({ confirm: false });
    const check = await L.publishChecklist(listing.id);
    expect(check.errors.join(" ")).toMatch(/owner has not confirmed/);
    await expectDomain(L.publishListing(lister, listing.id), /owner has not confirmed/);
    await confirmOwner(lister, authorizationId);
    await L.publishListing(lister, listing.id);
    expect((await reloadListing(listing.id)).status).toBe("published");
  });

  it("the database refuses a published status without an active authorisation (defence in depth)", async () => {
    const { listing } = await makeFlatListing({ confirm: false });
    await expectDbError(db.update(listings).set({ status: "published" }).where(eq(listings.id, listing.id)), /active authorisation/);
  });

  it("refuses price plans that do not declare brokerage and deposit", async () => {
    const { lister, listing } = await makeFlatListing();
    await expectDomain(
      L.setPricePlan(lister, listing.id, { planKey: "unit_monthly", appliesTo: "unit_monthly", label: "Flat", basePaise: 2_000_000, period: "month", charges: [] }),
      /brokerage must be declared/,
    );
  });

  it("blocks publishing with fewer than 3 photos and missing availability", async () => {
    await ensureLocalities();
    const lister = await makeLister();
    const { property, authorizationId } = await L.createProperty(lister, {
      category: "apartment",
      addressLine: "House 9, Lajpat Nagar II",
      localityId: "lajpat-nagar",
      amenities: [],
      houseRules: {},
      owner: { name: "Owner", phone: randomPhone() },
      authorizationBasis: "owner_mandate",
      units: [{ kind: "flat", label: "Flat", amenities: [] }],
    });
    await confirmOwner(lister, authorizationId);
    const [u] = await db.select().from(units).where(eq(units.propertyId, property.id));
    const l = await L.createListing(lister, { propertyId: property.id, category: "rent", title: "Empty listing for checks", unitIds: [u.id] });
    const { errors } = await L.publishChecklist(l.id);
    expect(errors.join("|")).toMatch(/at least one price plan/);
    expect(errors.join("|")).toMatch(/at least 3 photos/);
    expect(errors.join("|")).toMatch(/available-from date/);
  });

  it("moderates titles and descriptions", async () => {
    const { lister, listing } = await makeFlatListing();
    await expectDomain(L.updateListingDetails(lister, listing.id, { title: "Verified genuine flat!!", description: "" }), /reserved/);
    await expectDomain(L.updateListingDetails(lister, listing.id, { title: "Nice flat near metro", description: "Call 9876543210" }), /phone numbers/);
  });

  it("an organisation cannot edit another organisation's listing", async () => {
    const { listing } = await makeFlatListing();
    const other = await makeLister();
    await expectDomain(L.updateListingDetails(other, listing.id, { title: "Hijacked title here", description: "" }), /Not your listing/);
  });
});

describe("versioned pricing", () => {
  it("creates a new version on revision and keeps history; old rows are immutable", async () => {
    const { lister, listing } = await makeFlatListing();
    await L.setPricePlan(lister, listing.id, {
      planKey: "unit_monthly",
      appliesTo: "unit_monthly",
      label: "Whole flat",
      basePaise: 3_200_000,
      period: "month",
      charges: [
        { code: "security_deposit", mode: "months_of_rent", months: 2, recurrence: "one_time" },
        { code: "brokerage", mode: "none", recurrence: "one_time" },
      ],
    });
    const history = await L.priceHistory(listing.id);
    expect(history.map((h) => [h.version, h.basePaise, !!h.supersededAt])).toEqual([
      [1, 3_000_000, true],
      [2, 3_200_000, false],
    ]);
    const [old] = await db.select().from(pricePlans).where(and(eq(pricePlans.listingId, listing.id), eq(pricePlans.version, 1)));
    await expectDbError(db.update(pricePlans).set({ basePaise: 1 }).where(eq(pricePlans.id, old.id)), /immutable|insert-only/);
    await expectDbError(db.update(charges).set({ months: 9 }).where(eq(charges.pricePlanId, old.id)), /append-only/);
  });

  it("enquiry snapshots keep the price the renter saw", async () => {
    const { lister, listing } = await makeFlatListing({ brokerageMonths: 1 });
    await L.publishListing(lister, listing.id);
    const renter = await makeUser("Renter");
    const e = await createEnquiry(renter, { listingId: listing.id, planKey: "unit_monthly", moveInDate: addDays(today, 5) });
    await L.setPricePlan(lister, listing.id, {
      planKey: "unit_monthly",
      appliesTo: "unit_monthly",
      label: "Whole flat",
      basePaise: 4_000_000,
      period: "month",
      charges: [
        { code: "security_deposit", mode: "months_of_rent", months: 3, recurrence: "one_time" },
        { code: "brokerage", mode: "months_of_rent", months: 2, recurrence: "one_time" },
      ],
    });
    const t = await getEnquiryThread(renter, e.id);
    const snap = t.enquiry.priceSnapshot as { plan: { basePaise: number; brokeragePaise: number } };
    expect(snap.plan.basePaise).toBe(3_000_000);
    expect(snap.plan.brokeragePaise).toBe(3_000_000);
  });
});

describe("badges are derived from checks", () => {
  it("owner-authorised appears only after owner confirmation AND document review; revocation removes it", async () => {
    const { lister, listing, authorizationId } = await makeFlatListing();
    const admin = await makeAdmin();
    const l = await reloadListing(listing.id);
    let b = (await badgesForListing(l)).badges.find((x) => x.key === "owner_authorised")!;
    expect(b.earned).toBe(false);
    const doc = await submitAuthorizationDocument(lister, authorizationId, "ownership_document", { key: "priv/evidence/aa/test.png", sha256: "x" });
    b = (await badgesForListing(l)).badges.find((x) => x.key === "owner_authorised")!;
    expect(b.earned).toBe(false); // needs_review is not passed
    await decideCheck(admin, doc.id, "passed", "matches");
    b = (await badgesForListing(l)).badges.find((x) => x.key === "owner_authorised")!;
    expect(b.earned).toBe(true);
    // Expire the document check: the badge must disappear without any listing edit.
    await db.update(verificationChecks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verificationChecks.id, doc.id));
    b = (await badgesForListing(l)).badges.find((x) => x.key === "owner_authorised")!;
    expect(b.earned).toBe(false);
  });

  it("ID badge requires PAN name match and DigiLocker", async () => {
    const lister = await makeLister();
    const mismatch = await verifyPan(lister, "ABCDE1234F", "Completely Different Person");
    expect(mismatch.status).toBe("needs_review");
    await expect(verifyPan(lister, "BAD", "x")).rejects.toBeInstanceOf(DomainError);
    await verifyDigilocker(lister, true);
    const { listing } = await makeFlatListing({ lister });
    const b = (await badgesForListing(await reloadListing(listing.id))).badges.find((x) => x.key === "id_checked_broker")!;
    expect(b.earned).toBe(false);
    const [pan] = await db.select().from(verificationChecks).where(eq(verificationChecks.id, mismatch.id));
    expect((pan.data as { panMasked: string }).panMasked).toBe("ABCDE****F");
  });

  it("non-admins cannot decide checks", async () => {
    const lister = await makeLister();
    const c = await verifyPan(lister, "ABCDE1234F", "Someone Else Entirely");
    await expectDomain(decideCheck(lister, c.id, "passed", ""), /Admins only/);
  });
});

describe("freshness and renter signals", () => {
  it("stale after the cadence, expired later, and reconfirm restores it", async () => {
    const { lister, listing } = await makeFlatListing();
    await L.publishListing(lister, listing.id);
    await db.update(listings).set({ lastConfirmedAt: new Date(Date.now() - 15 * 86400_000) }).where(eq(listings.id, listing.id));
    await freshnessSweep();
    expect((await reloadListing(listing.id)).status).toBe("stale");
    expect((await L.searchListings({})).some((r) => r.id === listing.id)).toBe(false);
    await L.reconfirmListing(lister, listing.id);
    expect((await reloadListing(listing.id)).status).toBe("published");
    await db.update(listings).set({ lastConfirmedAt: new Date(Date.now() - 40 * 86400_000) }).where(eq(listings.id, listing.id));
    await freshnessSweep();
    expect((await reloadListing(listing.id)).status).toBe("expired");
  });

  it("two independent 'not available' reports auto-pause a listing", async () => {
    const { lister, listing } = await makeFlatListing();
    await L.publishListing(lister, listing.id);
    await createReport(await makeUser("R1"), listing.id, "not_available", "");
    expect((await reloadListing(listing.id)).status).toBe("published");
    await createReport(await makeUser("R2"), listing.id, "not_available", "");
    expect((await reloadListing(listing.id)).status).toBe("paused");
  });

  it("owner declining pauses listings that relied on the authorisation", async () => {
    const { lister, listing, authorizationId } = await makeFlatListing();
    await L.publishListing(lister, listing.id);
    const { ownerRespond, sendOwnerOtp } = await import("@/server/trust");
    const { devCode } = await sendOwnerOtp(authorizationId);
    await ownerRespond(authorizationId, devCode!, false);
    expect((await reloadListing(listing.id)).status).toBe("paused");
    await expectDomain(L.publishListing(lister, listing.id), /owner has not confirmed/);
  });
});

describe("duplicate detection", () => {
  it("flags identical photos at a distant address as a stolen-photo fraud case", async () => {
    const seed = 424242;
    const a = await makeFlatListing({ photoSeed: seed });
    const b = await makeFlatListing({ photoSeed: seed, locality: "laxmi-nagar", lat: 28.6304, lng: 77.2773, address: "Near Laxmi Nagar metro, Vikas Marg" });
    const res = await runDedupeForProperty(b.property.id);
    const hit = res.find((r) => r.otherId === a.property.id);
    expect(hit?.stolen).toBe(true);
    const [cand] = await db.select().from(dedupeCandidates).where(eq(dedupeCandidates.caseId, (await db.select().from(moderationCases).orderBy(sql`created_at desc`).limit(1))[0].id));
    expect((cand.signals as { sharedPhotos: number }).sharedPhotos).toBe(3);
  });

  it("does not flag different properties with different photos", async () => {
    const a = await makeFlatListing();
    const res = await runDedupeForProperty(a.property.id);
    expect(res.filter((r) => r.score >= 0.9)).toEqual([]);
  });

  it("admin can suspend a reported listing; it disappears from search", async () => {
    const { lister, listing } = await makeFlatListing();
    await L.publishListing(lister, listing.id);
    const report = await createReport(await makeUser(), listing.id, "fake_photos", "copied");
    await decideCase(await makeAdmin(), report.caseId!, "suspend_listing", "Photos copied from another listing");
    expect((await reloadListing(listing.id)).status).toBe("suspended");
    expect((await L.searchListings({})).some((r) => r.id === listing.id)).toBe(false);
  });
});

describe("audit log", () => {
  it("is append-only at the database level", async () => {
    const [row] = await db.select().from(auditEvents).limit(1);
    await expectDbError(db.update(auditEvents).set({ action: "tampered" }).where(eq(auditEvents.id, row.id)), /append-only/);
    await expectDbError(db.delete(auditEvents).where(eq(auditEvents.id, row.id)), /append-only/);
  });

  it("chain verification detects tampering", async () => {
    expect((await verifyAuditChain()).ok).toBe(true);
    const s = getSql();
    const [last] = await db.select().from(auditEvents).orderBy(sql`id desc`).limit(1);
    await s.unsafe("alter table audit_events disable trigger audit_events_no_update");
    try {
      await s`update audit_events set data = '{"tampered":true}'::jsonb where id = ${last.id}`;
      const v = await verifyAuditChain();
      expect(v.ok).toBe(false);
      expect(v.brokenAtId).toBe(last.id);
    } finally {
      await s`update audit_events set data = ${JSON.stringify(last.data)}::jsonb where id = ${last.id}`;
      await s.unsafe("alter table audit_events enable trigger audit_events_no_update");
    }
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it("concurrent appends keep the chain valid", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => db.transaction((tx) => writeAudit(tx, { actorUserId: null, actorRole: "system", action: "test.concurrent", subjectType: "test", subjectId: String(i) }))));
    expect((await verifyAuditChain()).ok).toBe(true);
  });
});

describe("enquiries, visits and outcomes", () => {
  it("runs the visit lifecycle with role checks", async () => {
    const { lister, listing } = await makeFlatListing();
    await L.publishListing(lister, listing.id);
    const renter = await makeUser();
    const e = await createEnquiry(renter, { listingId: listing.id, moveInDate: addDays(today, 3), message: "Hi" });
    await expectDomain(createEnquiry(renter, { listingId: listing.id }), /already have an open enquiry/);
    await expectDomain(proposeVisits(renter, e.id, [{ start: new Date(Date.now() + 86400_000).toISOString(), mode: "in_person" }]), /Only the lister/);
    await proposeVisits(lister, e.id, [
      { start: new Date(Date.now() + 86400_000).toISOString(), mode: "in_person" },
      { start: new Date(Date.now() + 2 * 86400_000).toISOString(), mode: "video" },
    ]);
    const t = await getEnquiryThread(renter, e.id);
    await expectDomain(updateVisit(lister, t.visits[0].id, "confirmed"), /Cannot change/);
    await updateVisit(renter, t.visits[0].id, "confirmed");
    const t2 = await getEnquiryThread(lister, e.id);
    expect(t2.visits.map((v) => v.status)).toEqual(["confirmed", "cancelled"]);
    expect(t2.enquiry.status).toBe("visit_scheduled");
    await recordOutcome(renter, e.id, { outcome: "rented_here" });
    expect((await getEnquiryThread(renter, e.id)).enquiry.status).toBe("closed_won");
    await expectDomain(getEnquiryThread(await makeUser(), e.id), /Not your enquiry/);
  });

  it("listers cannot enquire on their own listing and drafts accept no enquiries", async () => {
    const { lister, listing } = await makeFlatListing();
    await expectDomain(createEnquiry(await makeUser(), { listingId: listing.id }), /not accepting enquiries/);
    await L.publishListing(lister, listing.id);
    await expectDomain(createEnquiry(lister, { listingId: listing.id }), /own listing/);
  });

  it("brokerage paid above the disclosed amount opens a dispute case", async () => {
    const { lister, listing } = await makeFlatListing({ brokerageMonths: 0.5 });
    await L.publishListing(lister, listing.id);
    const renter = await makeUser();
    const e = await createEnquiry(renter, { listingId: listing.id });
    await recordOutcome(renter, e.id, { outcome: "rented_here", brokeragePaidRupees: 30000 });
    const cases = await db.select().from(moderationCases).where(and(eq(moderationCases.listingId, listing.id), eq(moderationCases.kind, "dispute")));
    expect(cases).toHaveLength(1);
  });
});

describe("hotel booking requests", () => {
  it("quotes, prevents overbooking and decrements inventory on confirmation", async () => {
    await ensureLocalities();
    const hotelier = await makeLister("hotel");
    const { property, authorizationId } = await L.createProperty(hotelier, {
      category: "hotel",
      name: "Test Hotel",
      addressLine: "1 Arya Samaj Road, Karol Bagh",
      localityId: "karol-bagh",
      amenities: [],
      houseRules: {},
      owner: { name: "Owner", phone: randomPhone() },
      authorizationBasis: "hotel_management",
      units: [{ kind: "hotel_room_type", label: "Deluxe", maxOccupancy: 2, inventoryCount: 3, amenities: [] }],
    });
    await confirmOwner(hotelier, authorizationId);
    const [u] = await db.select().from(units).where(eq(units.propertyId, property.id));
    const l = await L.createListing(hotelier, { propertyId: property.id, category: "short_stay", title: "Test hotel near metro station", unitIds: [u.id] });
    await L.setPricePlan(hotelier, l.id, { planKey: `rt:${u.id}`, unitId: u.id, appliesTo: "room_type_nightly", label: "Deluxe", basePaise: 280_000, period: "night", charges: [{ code: "tax", mode: "percent", percent: 5, recurrence: "nightly" }] });
    await L.setNightlyInventory(hotelier, u.id, { from: today, to: addDays(today, 20), availableCount: 1, ratePaise: 280_000 });
    await expectDomain(L.setNightlyInventory(hotelier, u.id, { from: today, to: today, availableCount: 9, ratePaise: 1 }), /between 0 and 3/);
    for (let i = 0; i < 3; i++) await handleUpload(hotelier, { name: "r.jpg", bytes: await noiseJpeg(800, 600, 900 + i) }, { propertyId: property.id, kind: "photo", unitId: u.id });
    await drainJobs();
    await L.publishListing(hotelier, l.id);
    const g1 = await makeUser();
    const g2 = await makeUser();
    const b1 = await createBookingRequest(g1, { listingId: l.id, unitId: u.id, from: addDays(today, 2), to: addDays(today, 4), guests: 2 });
    expect((b1.quote as { totalPaise: number }).totalPaise).toBe(2 * 280_000 * 1.05);
    const b2 = await createBookingRequest(g2, { listingId: l.id, unitId: u.id, from: addDays(today, 3), to: addDays(today, 5), guests: 1 });
    await expectDomain(createBookingRequest(g1, { listingId: l.id, unitId: u.id, from: addDays(today, 2), to: addDays(today, 4), guests: 3 }), /Maximum 2 guests/);
    await decideBooking(hotelier, b1.id, "confirmed");
    await expectDomain(decideBooking(hotelier, b2.id, "confirmed"), /Sold out/);
    const inv = await db.select().from(nightlyInventory).where(and(eq(nightlyInventory.unitId, u.id), eq(nightlyInventory.date, addDays(today, 2))));
    expect(inv[0].availableCount).toBe(0);
    await expectDomain(createBookingRequest(g2, { listingId: l.id, unitId: u.id, from: addDays(today, 2), to: addDays(today, 3), guests: 1 }), /Sold out/);
  });
});

describe("media pipeline", () => {
  it("rejects files whose content does not match the type", async () => {
    const { lister, property } = await makeFlatListing();
    await expectDomain(handleUpload(lister, { name: "fake.jpg", bytes: new TextEncoder().encode("not an image at all") }, { propertyId: property.id, kind: "photo" }), /valid photo/);
  });

  it("rejects non-panoramic images uploaded as 360° and processes real panoramas into 3D", async () => {
    const { lister, property } = await makeFlatListing();
    const bad = await handleUpload(lister, { name: "wide.jpg", bytes: await noiseJpeg(1600, 1200, 5) }, { propertyId: property.id, kind: "pano" });
    await processPano(bad.id);
    const [b] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, bad.id));
    expect(b.status).toBe("rejected");
    expect(b.rejectReason).toMatch(/2:1/);
    const zone = await L.createZone(lister, property.id, { label: "Living", roomType: "living" });
    await handleUpload(lister, { name: "pano.jpg", bytes: await noiseJpeg(2048, 1024, 6) }, { propertyId: property.id, kind: "pano", zoneId: zone.id });
    await drainJobs();
    await L.requestSplatBuild(lister, zone.id);
    await drainJobs();
    const tour = await L.getTourData(property.id, null);
    const z = tour.find((x) => x.id === zone.id)!;
    expect(z.pano?.url).toMatch(/^\/media\/pub\/pano\//);
    expect(z.splatStatus).toBe("ready");
    expect(z.splat?.url).toMatch(/\.spz$/);
    expect(z.splat?.splats).toBeGreaterThan(100_000);
  });

  it("rejects blurry photos with an actionable reason", async () => {
    const { lister, property } = await makeFlatListing();
    const sharp = (await import("sharp")).default;
    const flat = await sharp({ create: { width: 900, height: 700, channels: 3, background: "#d8d2c4" } }).jpeg().toBuffer();
    const a = await handleUpload(lister, { name: "blur.jpg", bytes: flat }, { propertyId: property.id, kind: "photo" });
    await drainJobs();
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, a.id));
    expect(row.status).toBe("rejected");
    expect(row.rejectReason).toMatch(/blurry/);
  });
});

describe("job queue", () => {
  it("never hands the same job to two workers", async () => {
    await db.delete(jobs).where(eq(jobs.kind, "notify.deliver"));
    for (let i = 0; i < 10; i++) await enqueue(db, "notify.deliver", { i });
    const results = await Promise.all(Array.from({ length: 5 }, (_, w) => claimJobs(`w${w}`, 3, ["notify.deliver"])));
    const ids = results.flat().map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);
  });
});

describe("search", () => {
  it("filters by brokerage, owner authorisation and move-in date", async () => {
    const a = await makeFlatListing({ brokerageMonths: 1 });
    const b = await makeFlatListing({ brokerageMonths: null });
    await L.publishListing(a.lister, a.listing.id);
    await L.publishListing(b.lister, b.listing.id);
    const noBrk = await L.searchListings({ noBrokerage: true });
    expect(noBrk.some((r) => r.id === b.listing.id)).toBe(true);
    expect(noBrk.some((r) => r.id === a.listing.id)).toBe(false);
    const auth = await L.searchListings({ ownerAuthorised: true });
    expect(auth.some((r) => r.id === a.listing.id)).toBe(false); // no document reviewed yet
    await L.setUnitAvailability(a.lister, a.unit.id, { availableFrom: addDays(today, 30), status: "available" });
    const soon = await L.searchListings({ moveIn: addDays(today, 7) });
    expect(soon.some((r) => r.id === a.listing.id)).toBe(false);
    expect(soon.some((r) => r.id === b.listing.id)).toBe(true);
  });
});
