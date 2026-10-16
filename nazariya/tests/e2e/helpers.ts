import { randomInt } from "node:crypto";
import type { Page } from "@playwright/test";

export const PHONES = { demoOwner: "9000000002", customer: "9000000001", admin: "9000000009" };

export function newPhone() {
  return `9${String(randomInt(0, 1e9)).padStart(9, "0")}`;
}

/** Logs in through the real OTP API (dev mode echoes the code); cookies land in the page context. */
export async function login(page: Page, phone: string) {
  const r = await page.request.post("/api/auth/otp/request", { data: { phone } });
  const { devCode } = await r.json();
  if (!devCode) throw new Error("DEV_TOOLS must be enabled for e2e");
  const v = await page.request.post("/api/auth/otp/verify", { data: { phone, code: devCode } });
  if (!v.ok()) throw new Error(await v.text());
}

/** Public id of a published demo space by name (via the landing page's demo iframes). */
export async function demoPublicId(page: Page, name: RegExp): Promise<string> {
  await page.goto("/");
  const frame = page.locator(`iframe[title]`).filter({ has: page.locator("xpath=self::*") });
  const titles = await page.locator("iframe[title]").evaluateAll((els) => els.map((e) => ({ title: e.getAttribute("title") ?? "", src: e.getAttribute("src") ?? "" })));
  void frame;
  const hit = titles.find((t) => name.test(t.title));
  if (!hit) throw new Error(`demo space ${name} not found`);
  return hit.src.match(/\/embed\/([a-z0-9]+)/)![1];
}
