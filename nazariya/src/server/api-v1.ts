import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { mediaAssets, spaces, zones } from "./schema";
import { apiSpace, mediaUrls } from "./studio";

export function baseUrl(req: Request) {
  return (process.env.APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
}

export async function apiListSpaces(orgId: string, base: string, filter: { externalRef?: string | null; status?: string | null }) {
  const conds = [eq(spaces.orgId, orgId)];
  conds.push(eq(spaces.status, filter.status === "draft" ? "draft" : "published"));
  if (filter.externalRef) conds.push(eq(spaces.externalRef, filter.externalRef));
  const rows = await db.select().from(spaces).where(and(...conds)).orderBy(desc(spaces.updatedAt)).limit(200);
  return decorate(rows, base);
}

export async function decorate(rows: (typeof spaces.$inferSelect)[], base: string) {
  if (!rows.length) return [];
  const counts = await db
    .select({ spaceId: zones.spaceId, rooms: sql<number>`count(*)::int`, threeD: sql<number>`count(*) filter (where ${zones.splatStatus} = 'ready')::int` })
    .from(zones)
    .where(inArray(zones.spaceId, rows.map((r) => r.id)))
    .groupBy(zones.spaceId);
  const posterIds = rows.map((r) => r.posterAssetId).filter((x): x is string => !!x);
  const posters = posterIds.length ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, posterIds)) : [];
  return rows.map((r) => {
    const c = counts.find((x) => x.spaceId === r.id);
    const p = mediaUrls(posters.find((x) => x.id === r.posterAssetId));
    return apiSpace(r, base, { rooms: c?.rooms ?? 0, threeD: c?.threeD ?? 0, posterUrl: p?.poster ?? p?.full ?? null });
  });
}
