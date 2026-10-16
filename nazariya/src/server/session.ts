import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type SessionUser, userFromToken } from "./auth";

export const SESSION_COOKIE = "nz_session";

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  return userFromToken(jar.get(SESSION_COOKIE)?.value);
});

export async function requireUser(next = "/"): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) redirect(`/login?next=${encodeURIComponent(next)}`);
  return u;
}

export function isAdmin(u: SessionUser | null): boolean {
  return !!u?.roles.includes("admin");
}

export function hasWorkspace(u: SessionUser | null): boolean {
  return !!u && u.orgs.length > 0;
}

export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser("/admin");
  if (!isAdmin(u)) redirect("/");
  return u;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && !(process.env.APP_URL ?? "").startsWith("http://"),
    path: "/",
    maxAge: 30 * 86400,
  };
}
