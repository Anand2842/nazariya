import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "./auth";
import { DomainError } from "./errors";

export function jsonError(e: unknown) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === "rate_limited" ? 429 : 400 });
  if (e instanceof DomainError) {
    const status = e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "conflict" ? 409 : 422;
    return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status });
  }
  if (e instanceof ZodError) {
    const details = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    console.warn(`[invalid-input] ${details.slice(0, 8).join(" | ")}`);
    return NextResponse.json({ error: "Invalid input", details }, { status: 422 });
  }
  console.error(e);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}

/** Same-origin check for state-changing JSON endpoints (cookies are SameSite=Lax; this adds CSRF defence). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return false;
  }
}

/** The acting user for an upload: a logged-in session, or a capture link (scoped to one space). */
export async function uploadActor(req: Request) {
  const { getCurrentUser } = await import("./session");
  const { resolveCaptureToken, touchCaptureLink } = await import("./capture");
  const token = req.headers.get("x-capture-token");
  if (token) {
    const ctx = await resolveCaptureToken(token);
    if (!ctx) return null;
    await touchCaptureLink(ctx.linkId);
    return { user: ctx.user, restrictSpaceId: ctx.spaceId };
  }
  const user = await getCurrentUser();
  return user ? { user, restrictSpaceId: null as string | null } : null;
}
