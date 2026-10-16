import { NextResponse } from "next/server";
import { apiListSpaces, baseUrl } from "@/server/api-v1";
import { orgFromApiKey } from "@/server/studio";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** GET /api/v1/spaces?externalRef=…  (Authorization: Bearer nz_live_…) */
export async function GET(req: Request) {
  const orgId = await orgFromApiKey(req.headers.get("authorization"));
  if (!orgId) return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401, headers: CORS });
  const u = new URL(req.url);
  const data = await apiListSpaces(orgId, baseUrl(req), { externalRef: u.searchParams.get("externalRef"), status: u.searchParams.get("status") });
  return NextResponse.json({ data }, { headers: CORS });
}
