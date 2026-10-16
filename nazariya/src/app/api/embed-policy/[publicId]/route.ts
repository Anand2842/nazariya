import { NextResponse } from "next/server";
import { frameAncestorsFor } from "@/server/studio";

// Consumed by middleware to emit a per-tour Content-Security-Policy frame-ancestors header.
export async function GET(_req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  if (!/^[a-z0-9]{6,20}$/.test(publicId)) return NextResponse.json({ frameAncestors: null }, { status: 404 });
  return NextResponse.json({ frameAncestors: await frameAncestorsFor(publicId) }, { headers: { "Cache-Control": "no-store" } });
}
