import { NextResponse } from "next/server";
import { jsonError, sameOrigin, uploadActor } from "@/server/http";
import { submitWalkFrames } from "@/server/walkthrough";

export const runtime = "nodejs";

/** Walkthrough keyframes recorded in depth mode: multipart with spaceId, meta (session, intrinsics, poses) and kf_N JPEGs. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const actor = await uploadActor(req);
  if (!actor) return NextResponse.json({ error: "Log in again or open a fresh capture link" }, { status: 401 });
  try {
    const form = await req.formData();
    const spaceId = String(form.get("spaceId") ?? "");
    if (actor.restrictSpaceId && spaceId !== actor.restrictSpaceId) return NextResponse.json({ error: "This capture link is for a different space" }, { status: 403 });
    const frames: { bytes: Uint8Array }[] = [];
    for (let i = 0; i < 16; i++) {
      const f = form.get(`kf_${i}`);
      if (!(f instanceof File)) break;
      frames.push({ bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    const r = await submitWalkFrames(actor.user, { spaceId, meta: JSON.parse(String(form.get("meta") ?? "{}")), frames });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return jsonError(e);
  }
}
