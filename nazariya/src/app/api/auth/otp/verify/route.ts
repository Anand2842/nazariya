import { NextResponse } from "next/server";
import { loginWithOtp } from "@/server/auth";
import { jsonError, sameOrigin } from "@/server/http";
import { cookieOptions, SESSION_COOKIE } from "@/server/session";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  try {
    const { phone, code } = (await req.json()) as { phone: string; code: string };
    const { token, user } = await loginWithOtp(phone, String(code ?? "").trim());
    const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.name, roles: user.roles, lister: user.orgs.length > 0 } });
    res.cookies.set(SESSION_COOKIE, token, cookieOptions());
    return res;
  } catch (e) {
    return jsonError(e);
  }
}
