import { describe, expect, it } from "vitest";
import { deriveBadges, type CheckLike } from "@/lib/badges";
import { dedupeScore, hammingHex, haversineMeters, isStolenPhotoPattern, normalizeAddress, trigramSimilarity } from "@/lib/dedupe";
import { freshnessState, relativeAge } from "@/lib/freshness";
import { moderateText } from "@/lib/moderation";
import { auditHash, canonicalJson, GENESIS_HASH } from "@/lib/audit-hash";

const now = new Date("2026-10-15T12:00:00Z");
const future = new Date("2027-10-15T00:00:00Z");
const past = new Date("2026-01-01T00:00:00Z");
const c = (subjectType: string, checkType: string, status = "passed", expiresAt: Date | null = future): CheckLike => ({ subjectType, checkType, status, expiresAt, decidedAt: past });

describe("deriveBadges", () => {
  const byKey = (checks: CheckLike[]) => Object.fromEntries(deriveBadges(checks, now).map((b) => [b.key, b]));
  it("earns ID badge only with OTP + PAN + DigiLocker all passed", () => {
    expect(byKey([c("user", "phone_otp"), c("user", "pan_verified")]).id_checked_broker.earned).toBe(false);
    expect(byKey([c("user", "phone_otp"), c("user", "pan_verified"), c("user", "identity_digilocker")]).id_checked_broker.earned).toBe(true);
  });
  it("ignores expired, revoked, failed and needs_review checks", () => {
    const base = [c("user", "phone_otp"), c("user", "pan_verified")];
    for (const bad of [c("user", "identity_digilocker", "passed", past), c("user", "identity_digilocker", "revoked"), c("user", "identity_digilocker", "failed"), c("user", "identity_digilocker", "needs_review")]) {
      expect(byKey([...base, bad]).id_checked_broker.earned).toBe(false);
    }
  });
  it("owner badge accepts any of ownership/lease/registration documents", () => {
    for (const doc of ["ownership_document", "operator_lease", "hotel_registration"]) {
      expect(byKey([c("authorization", "owner_contact_confirmation"), c("authorization", doc)]).owner_authorised.earned).toBe(true);
    }
    expect(byKey([c("authorization", "owner_contact_confirmation")]).owner_authorised.earned).toBe(false);
  });
  it("checks on the wrong subject type do not count", () => {
    expect(byKey([c("user", "owner_contact_confirmation"), c("user", "ownership_document")]).owner_authorised.earned).toBe(false);
  });
  it("reports the earliest expiry", () => {
    const soon = new Date("2026-12-01T00:00:00Z");
    const b = byKey([c("authorization", "owner_contact_confirmation", "passed", soon), c("authorization", "ownership_document")]).owner_authorised;
    expect(b.validUntil).toBe(soon.toISOString());
  });
});

describe("freshness", () => {
  const ago = (days: number) => new Date(now.getTime() - days * 86400_000);
  it("applies category cadences", () => {
    expect(freshnessState("pg", ago(1), now)).toBe("fresh");
    expect(freshnessState("pg", ago(5), now)).toBe("due_soon");
    expect(freshnessState("pg", ago(8), now)).toBe("stale");
    expect(freshnessState("pg", ago(15), now)).toBe("expired");
    expect(freshnessState("rent", ago(8), now)).toBe("fresh");
    expect(freshnessState("rent", ago(15), now)).toBe("stale");
    expect(freshnessState("short_stay", ago(2.5), now)).toBe("stale");
    expect(freshnessState("pg", null, now)).toBe("never_confirmed");
  });
  it("formats relative age", () => {
    expect(relativeAge(ago(2), now)).toBe("2 days ago");
    expect(relativeAge(new Date(now.getTime() - 30_000), now)).toBe("just now");
  });
});

describe("dedupe helpers", () => {
  it("normalises Indian address variants to the same form", () => {
    expect(normalizeAddress("B-2/114, Sec. 15, Rohini, New Delhi")).toBe(normalizeAddress("b 2 114 sector 15 rohini delhi"));
    expect(normalizeAddress("Flat 2B, Blk C, Lajpat Nagar IV")).toContain("block c");
  });
  it("trigram similarity is high for near-identical addresses", () => {
    expect(trigramSimilarity(normalizeAddress("J-12 Saket near Malviya Nagar metro"), normalizeAddress("J 12, Saket, nr Malviya Nagar Metro"))).toBeGreaterThan(0.7);
    expect(trigramSimilarity("rohini sector 15", "dwarka sector 12")).toBeLessThan(0.4);
  });
  it("haversine distance is plausible for Delhi", () => {
    const d = haversineMeters(28.5677, 77.2433, 28.6304, 77.2773); // Lajpat Nagar → Laxmi Nagar
    expect(d).toBeGreaterThan(7000);
    expect(d).toBeLessThan(8500);
  });
  it("hamming distance of hex hashes", () => {
    expect(hammingHex("ffff0000ffff0000", "ffff0000ffff0000")).toBe(0);
    expect(hammingHex("0000000000000000", "000000000000000f")).toBe(4);
  });
  it("scores duplicates and stolen-photo patterns", () => {
    expect(dedupeScore({ distanceM: 10, addressSimilarity: 0.95, samePhoneHash: true, sharedPhotos: 3 })).toBeGreaterThanOrEqual(0.9);
    expect(dedupeScore({ distanceM: 5000, addressSimilarity: 0.1, samePhoneHash: false, sharedPhotos: 0 })).toBeLessThan(0.5);
    expect(isStolenPhotoPattern({ distanceM: 7700, addressSimilarity: 0.2, samePhoneHash: false, sharedPhotos: 4 })).toBe(true);
    expect(isStolenPhotoPattern({ distanceM: 20, addressSimilarity: 0.9, samePhoneHash: false, sharedPhotos: 4 })).toBe(false);
  });
});

describe("moderateText", () => {
  it("allows normal descriptions", () => {
    expect(moderateText("Bright 2BHK with balcony, 8 minutes to metro. Two bathrooms.").ok).toBe(true);
  });
  it("blocks reserved trust claims", () => {
    expect(moderateText("100% verified genuine property").ok).toBe(false);
  });
  it("blocks phone numbers, emails and prices in text", () => {
    expect(moderateText("Call 98765 43210").ok).toBe(false);
    expect(moderateText("mail me at a@b.co").ok).toBe(false);
    expect(moderateText("Rent ₹25,000 only").ok).toBe(false);
    expect(moderateText("Rs. 18000 negotiable").ok).toBe(false);
  });
  it("blocks discriminatory exclusion", () => {
    expect(moderateText("Hindus only, no exceptions").ok).toBe(false);
    expect(moderateText("No Kashmiris").ok).toBe(false);
  });
});

describe("audit hashing", () => {
  const p = { occurredAt: "2026-10-15T00:00:00.000Z", actorUserId: null, actorRole: "system", action: "x", subjectType: "listing", subjectId: "1", data: { b: 1, a: [1, { d: 2, c: 3 }] } };
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it("hash changes when any field or the previous hash changes", () => {
    const h = auditHash(GENESIS_HASH, p);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(auditHash(GENESIS_HASH, { ...p, action: "y" })).not.toBe(h);
    expect(auditHash("1".repeat(64), p)).not.toBe(h);
    expect(auditHash(GENESIS_HASH, { ...p, data: { a: [1, { c: 3, d: 2 }], b: 1 } })).toBe(h);
  });
});
