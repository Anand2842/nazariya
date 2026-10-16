import { randomInt } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import sharp from "sharp";

export const PHONES = { renter: "9000000001", broker: "9000000002", pgOperator: "9000000003", hotel: "9000000004", admin: "9000000009" };

export function newPhone() {
  return `9${String(randomInt(0, 1e9)).padStart(9, "0")}`;
}

/** Logs in through the real OTP API (dev mode echoes the code). Cookies land in the page's context. */
export async function apiLogin(request: APIRequestContext, phone: string) {
  const r = await request.post("/api/auth/otp/request", { data: { phone } });
  const { devCode } = await r.json();
  if (!devCode) throw new Error("DEV_TOOLS must be enabled for e2e");
  const v = await request.post("/api/auth/otp/verify", { data: { phone, code: devCode } });
  if (!v.ok()) throw new Error(await v.text());
}

export async function login(page: Page, phone: string) {
  await apiLogin(page.request, phone);
}

export async function testPhoto(seed: number) {
  let x = seed || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x / 0x7fffffff);
  const w = 1200;
  const h = 900;
  const grid = Array.from({ length: 12 * 9 }, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
  const buf = Buffer.alloc(w * h * 3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const cell = grid[Math.floor((j / h) * 9) * 12 + Math.floor((i / w) * 12)];
      for (let c = 0; c < 3; c++) buf[(j * w + i) * 3 + c] = Math.max(0, Math.min(255, cell[c] + (rnd() - 0.5) * 50));
    }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

export async function slugOf(page: Page, title: RegExp) {
  await page.goto("/search");
  const link = page.getByTestId("listing-card").filter({ hasText: title }).first().getByRole("link").nth(1);
  const href = await link.getAttribute("href");
  return href!;
}
