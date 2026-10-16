import { NextResponse } from "next/server";
import { requestOtp } from "@/server/auth";
import { jsonError, sameOrigin } from "@/server/http";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  try {
    const { phone } = (await req.json()) as { phone: string };
    const r = await requestOtp(phone, "login");
    return NextResponse.json({ ok: true, phone: r.phone, devCode: r.devCode });
  } catch (e) {
    return jsonError(e);
  }
}
