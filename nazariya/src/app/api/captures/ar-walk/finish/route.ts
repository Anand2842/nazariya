import { NextResponse } from "next/server";
import { jsonError, sameOrigin, uploadActor } from "@/server/http";
import { finishWalkthrough } from "@/server/walkthrough";

export const runtime = "nodejs";

/** End of a depth-mode house capture: build the 3D walkthrough dataset (and run the GPU worker if configured). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const actor = await uploadActor(req);
  if (!actor) return NextResponse.json({ error: "Log in again or open a fresh capture link" }, { status: 401 });
  try {
    const body = (await req.json()) as { spaceId?: string; sessionId?: string };
    const spaceId = String(body.spaceId ?? "");
    if (actor.restrictSpaceId && spaceId !== actor.restrictSpaceId) return NextResponse.json({ error: "This capture link is for a different space" }, { status: 403 });
    await finishWalkthrough(actor.user, { spaceId, sessionId: String(body.sessionId ?? "") });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
