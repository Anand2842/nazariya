// Trust badges are DERIVED from verification checks: never stored, never typed by a lister.
// A badge is shown only when every required check has status "passed" and has not expired.

export interface CheckLike {
  checkType: string;
  status: string;
  subjectType: string;
  decidedAt?: Date | string | null;
  expiresAt?: Date | string | null;
}

export type BadgeKey = "id_checked_broker" | "owner_authorised" | "onsite_media" | "charges_disclosed";

export interface BadgeDefinition {
  key: BadgeKey;
  label: string;
  /** Each inner array is an alternative set; all checks in at least one set must pass (AND of OR-groups). */
  requires: { subjectType: string; anyOf: string[] }[];
  checked: string;
  notChecked: string;
}

export const BADGES: BadgeDefinition[] = [
  {
    key: "id_checked_broker",
    label: "ID-checked lister",
    requires: [
      { subjectType: "user", anyOf: ["phone_otp"] },
      { subjectType: "user", anyOf: ["pan_verified"] },
      { subjectType: "user", anyOf: ["identity_digilocker"] },
    ],
    checked: "Mobile number (OTP), PAN and government ID (DigiLocker consent) matched the lister's name.",
    notChecked: "This does not rate the lister's service or confirm they are RERA-registered.",
  },
  {
    key: "owner_authorised",
    label: "Owner-authorised listing",
    requires: [
      { subjectType: "authorization", anyOf: ["owner_contact_confirmation"] },
      { subjectType: "authorization", anyOf: ["ownership_document", "operator_lease", "hotel_registration"] },
    ],
    checked: "The owner (or registered operator) confirmed by phone that this lister may market the property, and an ownership/lease/registration document was reviewed.",
    notChecked: "We did not inspect the property in person or check legal title.",
  },
  {
    key: "onsite_media",
    label: "Photos taken on-site",
    requires: [{ subjectType: "listing", anyOf: ["onsite_capture_consistency"] }],
    checked: "Photos/360° captures were taken in the Nazariya app, at the property's location, recently.",
    notChecked: "Furniture and condition may have changed since capture.",
  },
  {
    key: "charges_disclosed",
    label: "Charges disclosed",
    requires: [{ subjectType: "listing", anyOf: ["charges_disclosed"] }],
    checked: "Rent, deposit and brokerage are declared as structured amounts before publishing.",
    notChecked: "Amounts are declared by the lister; report it if you are asked to pay more.",
  },
];

export interface DerivedBadge {
  key: BadgeKey;
  label: string;
  earned: boolean;
  checked: string;
  notChecked: string;
  /** Earliest expiry among the checks that earned the badge. */
  validUntil: string | null;
  verifiedAt: string | null;
  missing: string[];
}

export function isCheckValid(c: CheckLike, now: Date): boolean {
  if (c.status !== "passed") return false;
  if (c.expiresAt && new Date(c.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

export function deriveBadges(checks: CheckLike[], now: Date = new Date()): DerivedBadge[] {
  return BADGES.map((b) => {
    const missing: string[] = [];
    const used: CheckLike[] = [];
    for (const req of b.requires) {
      const match = checks
        .filter((c) => c.subjectType === req.subjectType && req.anyOf.includes(c.checkType) && isCheckValid(c, now))
        .sort((a, z) => new Date(z.decidedAt ?? 0).getTime() - new Date(a.decidedAt ?? 0).getTime())[0];
      if (match) used.push(match);
      else missing.push(req.anyOf.join(" or "));
    }
    const earned = missing.length === 0;
    const expiries = used.map((c) => (c.expiresAt ? new Date(c.expiresAt).getTime() : Infinity));
    const minExp = Math.min(...expiries);
    const latest = Math.max(...used.map((c) => (c.decidedAt ? new Date(c.decidedAt).getTime() : 0)), 0);
    return {
      key: b.key,
      label: b.label,
      earned,
      checked: b.checked,
      notChecked: b.notChecked,
      validUntil: earned && Number.isFinite(minExp) ? new Date(minExp).toISOString() : null,
      verifiedAt: earned && latest > 0 ? new Date(latest).toISOString() : null,
      missing,
    };
  });
}

/** Words a lister may not use in free text, because only the platform can make these claims. */
export const RESERVED_CLAIMS = [/\bverified\b/i, /\b100\s?%\s?genuine\b/i, /\bgenuine\b/i, /\bauthori[sz]ed\b/i, /\bguaranteed\b/i];
