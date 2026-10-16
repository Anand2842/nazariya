import { NextResponse } from "next/server";
import { jsonError, sameOrigin, uploadActor } from "@/server/http";
import { createZone } from "@/server/studio";

export const runtime = "nodejs";

/** Add a room while capturing on a phone (house walk-through). Works with a capture link. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const actor = await uploadActor(req);
  if (!actor) return NextResponse.json({ error: "Log in again or open a fresh capture link" }, { status: 401 });
  try {
    const body = (await req.json()) as { spaceId?: string; label?: string; roomType?: string };
    const spaceId = String(body.spaceId ?? "");
    if (actor.restrictSpaceId && spaceId !== actor.restrictSpaceId) return NextResponse.json({ error: "This capture link is for a different space" }, { status: 403 });
    const z = await createZone(actor.user, spaceId, { label: String(body.label ?? ""), roomType: body.roomType });
    return NextResponse.json({ ok: true, room: { id: z.id, label: z.label, roomType: z.roomType } });
  } catch (e) {
    return jsonError(e);
  }
}
