import { expect, test } from "@playwright/test";

test("mobile: facts stay reachable and the tour degrades to photos", async ({ page }) => {
  await page.goto("/search?category=rent");
  await page.getByTestId("listing-card").filter({ hasText: "Lajpat Nagar" }).first().getByRole("link").nth(1).click();
  const cta = page.getByTestId("mobile-cta");
  await expect(cta).toBeVisible();
  await expect(cta).toContainText("₹38,000");
  await expect(cta).toContainText("Brokerage: ₹38,000");
  // Simulate a device without WebGL: the viewer must still show something useful.
  const url = new URL(page.url());
  url.searchParams.set("tier", "photos");
  await page.goto(url.toString());
  await page.getByTestId("tour-start").click();
  await expect(page.getByTestId("photo-view").locator("img").first()).toBeVisible();
  await expect(page.getByTestId("tier-3d")).toBeDisabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await cta.getByRole("link", { name: "Enquire" }).click();
  await expect(page.getByTestId("enquiry-form")).toBeInViewport();
});
