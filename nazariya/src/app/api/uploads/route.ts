import { NextResponse } from "next/server";
import { jsonError, sameOrigin, uploadActor } from "@/server/http";
import { handleUpload, type UploadKind } from "@/server/media";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const actor = await uploadActor(req);
  if (!actor) return NextResponse.json({ error: "Log in again or open a fresh capture link" }, { status: 401 });
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    const spaceId = (form.get("spaceId") as string) || null;
    const kind = String(form.get("kind")) as UploadKind;
    if (actor.restrictSpaceId && (spaceId !== actor.restrictSpaceId || kind === "logo")) return NextResponse.json({ error: "This capture link is for a different space" }, { status: 403 });
    let capture = null;
    try {
      capture = form.get("capture") ? JSON.parse(String(form.get("capture"))) : null;
    } catch {}
    const asset = await handleUpload(actor.user, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, { spaceId, kind, zoneId: (form.get("zoneId") as string) || null, capture });
    return NextResponse.json({ ok: true, asset: { id: asset.id, status: asset.status, kind: asset.kind } });
  } catch (e) {
    return jsonError(e);
  }
}
