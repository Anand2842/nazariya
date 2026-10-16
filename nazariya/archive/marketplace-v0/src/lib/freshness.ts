// Listing freshness: listers must reconfirm availability on a category-specific cadence.
export type ListingCategory = "pg" | "rent" | "short_stay";

export const FRESHNESS_RULES: Record<ListingCategory, { cadenceDays: number; staleGraceDays: number; expireAfterStaleDays: number }> = {
  pg: { cadenceDays: 7, staleGraceDays: 0, expireAfterStaleDays: 7 },
  rent: { cadenceDays: 14, staleGraceDays: 0, expireAfterStaleDays: 14 },
  short_stay: { cadenceDays: 1, staleGraceDays: 1, expireAfterStaleDays: 30 },
};

export type FreshnessState = "fresh" | "due_soon" | "stale" | "expired" | "never_confirmed";

const DAY = 86400000;

export function freshnessState(category: ListingCategory, lastConfirmedAt: Date | string | null, now: Date = new Date()): FreshnessState {
  if (!lastConfirmedAt) return "never_confirmed";
  const rule = FRESHNESS_RULES[category];
  const age = now.getTime() - new Date(lastConfirmedAt).getTime();
  const staleAt = (rule.cadenceDays + rule.staleGraceDays) * DAY;
  if (age >= staleAt + rule.expireAfterStaleDays * DAY) return "expired";
  if (age >= staleAt) return "stale";
  if (age >= rule.cadenceDays * DAY * 0.7) return "due_soon";
  return "fresh";
}

export function confirmDueAt(category: ListingCategory, lastConfirmedAt: Date | string): Date {
  return new Date(new Date(lastConfirmedAt).getTime() + FRESHNESS_RULES[category].cadenceDays * DAY);
}

export function relativeAge(from: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(from).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
