// Duplicate-property detection helpers. Candidates are linked and reviewed, never auto-merged.

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bsec(tor)?\b\.?/g, "sector"],
  [/\bblk\b\.?/g, "block"],
  [/\bnr\b\.?/g, "near"],
  [/\bopp\b\.?/g, "opposite"],
  [/\brd\b\.?/g, "road"],
  [/\bmkt\b\.?/g, "market"],
  [/\bapt(s)?\b\.?/g, "apartment"],
  [/\bflr\b\.?/g, "floor"],
  [/\bgf\b/g, "ground floor"],
  [/\bph\b\.?/g, "phase"],
  [/\bext(n)?\b\.?/g, "extension"],
  [/\bnew delhi\b/g, "delhi"],
];

/** Normalise an Indian address for comparison: "B-2/114, Sec. 15, Rohini" -> "b 2 114 sector 15 rohini". */
export function normalizeAddress(raw: string): string {
  let s = raw.toLowerCase().normalize("NFKD");
  s = s.replace(/[.,;:#()\-/\\]/g, " ");
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = s.replace(/(\d+)(st|nd|rd|th)\b/g, "$1");
  s = s.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");
  s = s.replace(/\b(india|delhi ncr)\b/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.split(" ").filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

/** Trigram similarity compatible in spirit with pg_trgm's similarity(). */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Hamming distance between two 64-bit hex dHashes. */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export interface DedupeSignals {
  distanceM: number;
  addressSimilarity: number;
  samePhoneHash: boolean;
  /** Number of near-identical photos shared between the two properties (Hamming <= 8). */
  sharedPhotos: number;
}

/** Weighted score in [0,1]. >= 0.9 strong duplicate, 0.5–0.9 review, < 0.5 ignore. */
export function dedupeScore(s: DedupeSignals): number {
  const geo = s.distanceM <= 25 ? 1 : s.distanceM <= 75 ? 0.7 : s.distanceM <= 200 ? 0.3 : 0;
  const addr = Math.max(0, (s.addressSimilarity - 0.3) / 0.7);
  const photo = s.sharedPhotos >= 3 ? 1 : s.sharedPhotos * 0.34;
  let score = 0.35 * geo + 0.3 * addr + 0.35 * photo;
  if (s.samePhoneHash) score += 0.15;
  return Math.min(1, Math.round(score * 1000) / 1000);
}

/** Stolen-photo signal: identical photos at locations far apart is suspicious regardless of address. */
export function isStolenPhotoPattern(s: DedupeSignals): boolean {
  return s.sharedPhotos >= 2 && s.distanceM > 500;
}
