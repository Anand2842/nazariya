import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession } from "@/server/auth";
import { SESSION_COOKIE } from "@/server/session";

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(token);
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
