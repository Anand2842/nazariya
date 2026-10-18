import { appendFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { sameOrigin, uploadActor } from "@/server/http";

export const runtime = "nodejs";

/**
 * Capture diagnostics from phones in the field: when depth-mode capture stalls, the phone reports what its
 * capture gate sees (aim, roll, steadiness, distance from the spot, tracking, pending camera reads). Logged as
 * one line per report; nothing is stored.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const actor = await uploadActor(req);
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const text = await req.text();
  if (text.length > 4000) return NextResponse.json({ error: "Too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const line = JSON.stringify({ server: new Date().toISOString(), user: actor.user.id, ...(body as object) });
  console.warn(`[capture-diag] ${line}`);
  // Local testing: one JSON line per report in .capture-live.jsonl, for following a phone capture live.
  if (process.env.NODE_ENV !== "production" || process.env.CAPTURE_LIVE_LOG === "1") await appendFile(path.join(process.cwd(), ".capture-live.jsonl"), line + "\n").catch(() => {});
  return NextResponse.json({ ok: true });
}
