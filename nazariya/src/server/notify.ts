// Notification outbox. In development messages are "delivered" to the outbox page (/dev/outbox)
// and the worker log. A production adapter sends WhatsApp templates / SMS through a BSP.
import { eq } from "drizzle-orm";
import { type Exec } from "./db";
import { notifications, users } from "./schema";

export interface NotificationInput {
  userId?: string | null;
  toPhone?: string | null;
  channel?: "whatsapp" | "sms";
  template: string;
  body: string;
  payload?: Record<string, unknown>;
}

export async function queueNotification(exec: Exec, n: NotificationInput) {
  let phone = n.toPhone ?? null;
  if (!phone && n.userId) {
    const [u] = await exec.select({ phone: users.phone }).from(users).where(eq(users.id, n.userId));
    phone = u?.phone ?? null;
  }
  await exec.insert(notifications).values({
    userId: n.userId ?? null,
    toPhone: phone,
    channel: n.channel ?? "whatsapp",
    template: n.template,
    body: n.body,
    payload: n.payload ?? {},
  });
}

export function appUrl(path = ""): string {
  return (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "") + path;
}

/** Dev tools (OTP echo, outbox page) are off unless DEV_TOOLS=1, and never on in production builds
 *  unless ALLOW_DEV_TOOLS_IN_PROD=1 is also set (used only for local end-to-end tests). */
export function devToolsEnabled(): boolean {
  if (process.env.DEV_TOOLS !== "1") return false;
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_TOOLS_IN_PROD === "1";
}
