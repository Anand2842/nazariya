import { NextResponse } from "next/server";
import { z } from "zod";
import { recordViewEvent } from "@/server/studio";

const schema = z.object({
  name: z.string().max(40),
  publicId: z.string().regex(/^[a-z0-9]{6,20}$/),
  zoneId: z.string().max(40).optional().nullable(),
  sessionId: z.string().max(64).optional().nullable(),
  referrer: z.string().max(500).optional().nullable(),
  surface: z.string().max(20).optional().nullable(),
  props: z.record(z.string(), z.unknown()).default({}),
});

// Anonymous viewer analytics from embeds/share pages (no cookies, no personal data).
export async function POST(req: Request) {
  try {
    const body = schema.parse(JSON.parse(await req.text()));
    await recordViewEvent(body);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "bad event" }, { status: 400 });
  }
}
