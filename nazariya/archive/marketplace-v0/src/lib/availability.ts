// Category-specific availability rules.

export interface BedLike {
  status: string; // vacant | occupied | notice | reserved | blocked
  noticeUntil?: string | null;
  reservedUntil?: string | null;
}

/** Date (YYYY-MM-DD) from which a bed can be occupied, or null if not foreseeably available. */
export function bedAvailableFrom(bed: BedLike, today: string): string | null {
  switch (bed.status) {
    case "vacant":
      return today;
    case "notice":
      return bed.noticeUntil ? addDays(bed.noticeUntil, 1) : null;
    case "reserved":
      return bed.reservedUntil ? addDays(bed.reservedUntil, 1) : null;
    default:
      return null;
  }
}

export interface RoomBeds {
  unitId: string;
  sharing: number;
  beds: BedLike[];
}

export interface SharingAvailability {
  sharing: number;
  availableNow: number;
  earliestFrom: string | null;
  bedsTotal: number;
}

/** Summarise PG availability per sharing type, e.g. "2 beds in double sharing from 1 Dec". */
export function pgAvailability(rooms: RoomBeds[], today: string): SharingAvailability[] {
  const by = new Map<number, SharingAvailability>();
  for (const r of rooms) {
    const s = by.get(r.sharing) ?? { sharing: r.sharing, availableNow: 0, earliestFrom: null, bedsTotal: 0 };
    for (const b of r.beds) {
      s.bedsTotal++;
      const from = bedAvailableFrom(b, today);
      if (!from) continue;
      if (from <= today) s.availableNow++;
      if (!s.earliestFrom || from < s.earliestFrom) s.earliestFrom = from;
    }
    by.set(r.sharing, s);
  }
  return [...by.values()].sort((a, b) => a.sharing - b.sharing);
}

/** True if a PG listing can house someone moving in on `moveIn`. */
export function pgHasBedFor(rooms: RoomBeds[], moveIn: string, today: string, sharing?: number): boolean {
  return rooms.some(
    (r) =>
      (sharing === undefined || r.sharing === sharing) &&
      r.beds.some((b) => {
        const from = bedAvailableFrom(b, today);
        return from !== null && from <= moveIn;
      }),
  );
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayIST(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
}

export const SHARING_LABEL: Record<number, string> = { 1: "Single", 2: "Double", 3: "Triple", 4: "Four" };
export function sharingLabel(n: number): string {
  return SHARING_LABEL[n] ?? `${n}-sharing`;
}
