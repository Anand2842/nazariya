import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { baseUrl, decorate } from "@/server/api-v1";
import { db } from "@/server/db";
import { spaces } from "@/server/schema";
import { getTourZones, orgFromApiKey } from "@/server/studio";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** GET /api/v1/spaces/:id: space detail with rooms (for native apps that build their own UI). */
export async function GET(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const orgId = await orgFromApiKey(req.headers.get("authorization"));
  if (!orgId) return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401, headers: CORS });
  const { publicId } = await ctx.params;
  const [s] = await db.select().from(spaces).where(and(eq(spaces.publicId, publicId), eq(spaces.orgId, orgId)));
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS });
  const base = baseUrl(req);
  const [summary] = await decorate([s], base);
  const zones = await getTourZones(s.id);
  const abs = (u: string | null | undefined) => (u ? base + u : null);
  return NextResponse.json(
    {
      data: {
        ...summary,
        description: s.description,
        address: s.address,
        rooms: zones.map((z) => ({
          id: z.id,
          name: z.label,
          type: z.roomType,
          embedUrl: `${summary.embedUrl}?room=${z.id}`,
          panorama: abs(z.pano?.url),
          scene3d: abs(z.splat?.url),
          scene3dMobile: abs(z.splat?.mobileUrl),
          photos: z.photos.map((p) => abs(p.url)),
          hotspots: z.hotspots.map((h) => ({ type: h.type, title: h.title, body: h.body, yaw: h.yaw, pitch: h.pitch, targetRoomId: h.targetZoneId, url: h.url })),
        })),
      },
    },
    { headers: CORS },
  );
}
