import { expect, test } from "@playwright/test";
import { login, PHONES } from "./helpers";

test("landing page shows a live demo tour and developer docs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("3D tours");
  const demo = page.frameLocator("[data-testid=landing-embed]");
  await expect(demo.getByTestId("tour-start")).toBeVisible();
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: /JavaScript SDK/ })).toBeVisible();
});

test("admin can verify the audit chain; others cannot open admin", async ({ page }) => {
  await login(page, PHONES.customer);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
  await login(page, PHONES.admin);
  await page.goto("/admin");
  await expect(page.getByTestId("admin-orgs")).toContainText("Nazariya Demo");
  await page.getByTestId("audit-verify").click();
  await expect(page.getByTestId("audit-result")).toContainText("Chain intact");
});

test("a customer's draft space is visible in their studio but not publicly", async ({ page }) => {
  await login(page, PHONES.customer);
  await page.goto("/studio");
  await page.getByTestId("space-card").filter({ hasText: "Tower B" }).click();
  await expect(page.getByTestId("space-status")).toHaveText("draft");
  const href = await page.getByTestId("preview-link").getAttribute("href");
  await page.goto(href!);
  await expect(page.getByTestId("preview-badge")).toBeVisible();
  const anon = await page.context().browser()!.newContext();
  const p2 = await anon.newPage();
  await p2.goto(href!);
  await expect(p2.getByTestId("tour-unavailable")).toBeVisible();
  await anon.close();
});
