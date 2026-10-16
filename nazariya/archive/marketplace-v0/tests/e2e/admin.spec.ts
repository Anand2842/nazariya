import { expect, test } from "@playwright/test";
import { login, PHONES } from "./helpers";

test("admin: review a document, verify the audit chain, act on a fraud report", async ({ page }) => {
  await login(page, PHONES.admin);
  await page.goto("/admin");
  await expect(page.getByTestId("admin")).toBeVisible();
  const pending = page.getByTestId("check-queue").locator("li").filter({ hasText: "Ownership document reviewed" });
  if (await pending.count()) {
    await expect(pending.first().getByRole("link", { name: /View evidence/ })).toBeVisible();
    await pending.first().getByLabel("Reason").fill("Mandate letter matches owner on record");
    await pending.first().getByTestId("check-approve").click();
    await expect(pending).toHaveCount(0);
  }
  await page.getByTestId("audit-verify").click();
  await expect(page.getByTestId("audit-result")).toContainText("Chain intact");

  // Rohit's Dwarka listing now carries the owner-authorised badge.
  await page.goto("/search?locality=dwarka-sector-12");
  await page.getByTestId("listing-card").filter({ hasText: "two balconies" }).getByRole("link").nth(1).click();
  await expect(page.getByTestId("badge-owner_authorised")).toBeVisible();
  await expect(page.getByTestId("other-listers")).toContainText("Capital Homes");

  // Fraud case: suspend the listing that reused another flat's photos.
  await page.goto("/admin");
  const cases = page.getByTestId("case").filter({ hasText: "Cheap 2BHK" }).filter({ hasText: /report/i });
  if (await cases.count()) {
    const c = cases.first();
    await c.getByLabel("Decision").selectOption("suspend_listing");
    await c.getByLabel("Rationale").fill("Photos copied from a Lajpat Nagar listing");
    await c.getByTestId("case-decide").click();
    await expect(cases).toHaveCount(0);
  }
  await page.goto("/search?category=rent");
  await expect(page.getByTestId("listing-card").filter({ hasText: "Cheap 2BHK" })).toHaveCount(0);
});

test("non-admins cannot open the admin console or private evidence", async ({ page }) => {
  await login(page, PHONES.renter);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
  const r = await page.request.get("/admin/evidence/00000000-0000-0000-0000-000000000000?e=x");
  expect(r.status()).toBe(403);
});
