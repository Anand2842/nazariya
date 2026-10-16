import { NextResponse } from "next/server";
import { submitPanoCapture } from "@/server/capture";
import { jsonError, sameOrigin, uploadActor } from "@/server/http";

export const runtime = "nodejs";

/** Guided in-app 360°: multipart with spaceId, zoneId, meta (JSON with per-frame device orientation) and frame_N files. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const actor = await uploadActor(req);
  if (!actor) return NextResponse.json({ error: "Log in again or open a fresh capture link" }, { status: 401 });
  try {
    const form = await req.formData();
    const spaceId = String(form.get("spaceId") ?? "");
    if (actor.restrictSpaceId && spaceId !== actor.restrictSpaceId) return NextResponse.json({ error: "This capture link is for a different space" }, { status: 403 });
    const frames: { name: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < 40; i++) {
      const f = form.get(`frame_${i}`);
      if (!(f instanceof File)) break;
      frames.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    const asset = await submitPanoCapture(actor.user, { spaceId, zoneId: String(form.get("zoneId") ?? ""), meta: JSON.parse(String(form.get("meta") ?? "{}")), frames });
    return NextResponse.json({ ok: true, asset: { id: asset.id, status: asset.status } });
  } catch (e) {
    return jsonError(e);
  }
}
