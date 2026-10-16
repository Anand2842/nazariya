// Phone-OTP authentication (framework-agnostic core; Next cookie glue lives in session.ts).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { writeAudit } from "./audit";
import { db, type Exec } from "./db";
import { devToolsEnabled, queueNotification } from "./notify";
import { memberships, organizations, otpCodes, sessions, users } from "./schema";

export class AuthError extends Error {
  constructor(
    message: string,
    public code: "invalid_phone" | "rate_limited" | "invalid_code" | "expired" | "too_many_attempts" | "unauthenticated" | "forbidden",
  ) {
    super(message);
  }
}

/** Accepts "98765 43210", "+91-9876543210", "09876543210" → "+919876543210". Indian mobiles only. */
export function normalizePhone(input: string): string {
  const digits = String(input ?? "").replace(/[^\d+]/g, "");
  let d = digits.startsWith("+") ? digits.slice(1) : digits;
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  if (!/^91[6-9]\d{9}$/.test(d)) throw new AuthError("Enter a valid 10-digit Indian mobile number", "invalid_phone");
  return "+" + d;
}

export function maskPhone(phone: string): string {
  return phone.replace(/^(\+91)(\d{2})\d{5}(\d{3})$/, "$1 $2xxxxx$3");
}

function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-secret-change-me";
}

function hashCode(phone: string, code: string): string {
  return createHash("sha256").update(`${phone}:${code}:${secret()}`).digest("hex");
}

const OTP_TTL_MS = 10 * 60 * 1000;
/** Per-phone OTP requests per hour (keep the default in production; local e2e runs raise it via env). */
const MAX_OTP_PER_HOUR = Math.max(1, Number(process.env.OTP_MAX_PER_HOUR ?? 6));
const MAX_ATTEMPTS = 5;

export async function requestOtp(
  rawPhone: string,
  purpose: "login" | "owner_confirmation" = "login",
  context: Record<string, unknown> = {},
): Promise<{ phone: string; devCode?: string }> {
  const phone = normalizePhone(rawPhone);
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, new Date(Date.now() - 3600_000))));
  if ((recent[0]?.n ?? 0) >= MAX_OTP_PER_HOUR) throw new AuthError("Too many codes requested. Try again in an hour.", "rate_limited");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.transaction(async (tx) => {
    await tx.insert(otpCodes).values({ phone, purpose, codeHash: hashCode(phone, code), expiresAt: new Date(Date.now() + OTP_TTL_MS), context });
    await queueNotification(tx, {
      toPhone: phone,
      channel: "sms",
      template: `otp_${purpose}`,
      body: `${code} is your Nazariya verification code. It expires in 10 minutes. Never share it with anyone.`,
      payload: { purpose },
    });
  });
  return devToolsEnabled() ? { phone, devCode: code } : { phone };
}

export async function verifyOtp(rawPhone: string, code: string, purpose: "login" | "owner_confirmation" = "login") {
  const phone = normalizePhone(rawPhone);
  const [row] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!row) throw new AuthError("Request a new code", "invalid_code");
  if (row.expiresAt.getTime() < Date.now()) throw new AuthError("This code has expired. Request a new one.", "expired");
  if (row.attempts >= MAX_ATTEMPTS) throw new AuthError("Too many wrong attempts. Request a new code.", "too_many_attempts");
  const ok =
    /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(hashCode(phone, code), "hex"), Buffer.from(row.codeHash, "hex"));
  if (!ok) {
    await db.update(otpCodes).set({ attempts: row.attempts + 1 }).where(eq(otpCodes.id, row.id));
    throw new AuthError("Incorrect code", "invalid_code");
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id));
  return { phone, context: (row.context ?? {}) as Record<string, unknown> };
}

export interface SessionUser {
  id: string;
  phone: string;
  name: string | null;
  roles: string[];
  orgs: { id: string; name: string; plan: string; role: string }[];
}

export async function upsertUserByPhone(exec: Exec, phone: string, name?: string | null) {
  const [existing] = await exec.select().from(users).where(eq(users.phone, phone));
  if (existing) return existing;
  const [created] = await exec.insert(users).values({ phone, name: name ?? null }).returning();
  return created;
}

export async function loginWithOtp(rawPhone: string, code: string): Promise<{ token: string; user: SessionUser }> {
  const { phone } = await verifyOtp(rawPhone, code, "login");
  const token = randomBytes(32).toString("base64url");
  const userId = await db.transaction(async (tx) => {
    const u = await upsertUserByPhone(tx, phone);
    await tx.insert(sessions).values({ id: tokenHash(token), userId: u.id, expiresAt: new Date(Date.now() + 30 * 86400_000) });
    await writeAudit(tx, { actorUserId: u.id, actorRole: "user", action: "auth.login", subjectType: "user", subjectId: u.id });
    return u.id;
  });
  const user = await loadSessionUser(userId);
  return { token, user: user! };
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function loadSessionUser(userId: string): Promise<SessionUser | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.status !== "active") return null;
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name, plan: organizations.plan, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, u.id));
  return { id: u.id, phone: u.phone, name: u.name, roles: u.roles, orgs };
}

export async function userFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const [s] = await db.select().from(sessions).where(eq(sessions.id, tokenHash(token)));
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  return loadSessionUser(s.userId);
}

export async function destroySession(token: string) {
  await db.delete(sessions).where(eq(sessions.id, tokenHash(token)));
}
