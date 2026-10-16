import { RESERVED_CLAIMS } from "./badges";

export interface ModerationResult {
  ok: boolean;
  errors: string[];
}

const PHONE_RE = /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PRICE_RE = /(₹|\brs\.?\s?|\binr\s?)\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*\s?(\/-|rupees)\b/i;
const DISCRIMINATION_RE: RegExp[] = [
  /\b(only|no)\s+(hindus?|muslims?|christians?|sikhs?|jains?|buddhists?|parsis?)\b/i,
  /\b(hindus?|muslims?|christians?|sikhs?|jains?)\s+only\b/i,
  /\b(caste|jaati|brahmins?\s+only|sc\/st\s+not)\b/i,
  /\bno\s+(north[\s-]?east(erners)?|kashmiris?|biharis?|south\s+indians?)\b/i,
  /\b(non[\s-]?veg(etarians?)?)\s+(people|tenants|families)\s+not\s+allowed\b/i,
];

/** Moderate lister-written free text (titles, descriptions, hotspot text). */
export function moderateText(text: string, opts: { allowPrices?: boolean } = {}): ModerationResult {
  const errors: string[] = [];
  for (const re of RESERVED_CLAIMS) {
    if (re.test(text)) {
      errors.push('Words like "verified", "genuine" or "authorised" are reserved: Nazariya shows badges only after checks pass.');
      break;
    }
  }
  if (PHONE_RE.test(text) || EMAIL_RE.test(text)) errors.push("Remove phone numbers/emails: renters contact you through Nazariya.");
  if (!opts.allowPrices && PRICE_RE.test(text)) errors.push("Put rent, deposit and charges in the Pricing section, not in text, so they stay consistent everywhere.");
  for (const re of DISCRIMINATION_RE) {
    if (re.test(text)) {
      errors.push("Text that excludes people by religion, caste, region or similar is not allowed.");
      break;
    }
  }
  return { ok: errors.length === 0, errors };
}
