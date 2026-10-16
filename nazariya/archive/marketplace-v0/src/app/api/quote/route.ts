import { NextResponse } from "next/server";
import { quoteForListing } from "@/server/enquiries";
import { jsonError } from "@/server/http";

export async function GET(req: Request) {
  const u = new URL(req.url);
  try {
    const r = await quoteForListing(u.searchParams.get("listingId") ?? "", u.searchParams.get("unitId") ?? "", u.searchParams.get("from") ?? "", u.searchParams.get("to") ?? "");
    return NextResponse.json(r);
  } catch (e) {
    return jsonError(e);
  }
}
