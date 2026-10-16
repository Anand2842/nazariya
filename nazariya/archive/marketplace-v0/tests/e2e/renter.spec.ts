import { expect, test } from "@playwright/test";
import { newPhone } from "./helpers";

test("renter: discover a PG, walk the room tour, and send an enquiry with OTP login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("See the real room");
  await page.getByLabel("Category").selectOption("pg");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/category=pg/);
  const card = page.getByTestId("listing-card").filter({ hasText: "Sunrise Women's PG" });
  await expect(card).toBeVisible();
  // The stale Scholars PG must not appear in search.
  await expect(page.getByTestId("listing-card").filter({ hasText: "Budget boys PG" })).toHaveCount(0);
  await card.getByRole("link").nth(1).click();

  await expect(page.getByTestId("listing-title")).toContainText("Sunrise Women's PG");
  await expect(page.getByTestId("freshness")).toContainText("confirmed");
  await expect(page.getByTestId("badge-id_checked_broker")).toBeVisible();
  await expect(page.getByTestId("badge-owner_authorised")).toBeVisible();
  await page.getByTestId("badge-owner_authorised").click();
  await expect(page.getByRole("note")).toContainText("Not checked");
  await expect(page.getByTestId("price-bed_double").getByTestId("charge-brokerage")).toHaveText("No brokerage");
  await expect(page.getByTestId("pg-availability")).toContainText("Double sharing");

  // Tour: poster first, then the best tier for this device.
  await page.getByTestId("tour-start").click();
  await expect(page.locator("[data-testid=splat-view][data-loaded=true], [data-testid=pano-view]").first()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("tier-360").click();
  await expect(page.getByTestId("pano-view")).toBeVisible();
  await page.getByTestId("room-list").getByRole("tab", { name: /Dining/ }).click();
  await expect(page.getByTestId("room-list").getByRole("tab", { name: /Dining/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/zone=/);
  await page.getByTestId("tier-photos").click();
  await expect(page.getByTestId("photo-view").locator("img").first()).toBeVisible();

  // Enquiry → OTP login inline → enquiry sent.
  await page.getByLabel("Option", { exact: true }).selectOption("bed_double");
  await page.getByLabel("Message (optional)").fill("Hello, I would like to visit on Saturday.");
  await page.getByTestId("enquiry-submit").click();
  await expect(page.getByTestId("otp-login")).toBeVisible();
  await page.getByLabel("Mobile number").fill(newPhone());
  await page.getByTestId("otp-submit").click();
  const code = (await page.getByTestId("dev-otp").locator("b").textContent())!;
  await page.getByLabel(/6-digit code/).fill(code);
  await page.getByTestId("otp-submit").click();
  await expect(page.getByTestId("enquiry-form")).toBeVisible();
  await page.getByTestId("enquiry-submit").click();
  await expect(page.getByTestId("enquiry-done")).toContainText("Enquiry sent");

  await page.goto("/me");
  await expect(page.getByTestId("my-enquiries")).toContainText("Sunrise Women's PG");
  await page.getByTestId("my-enquiries").getByRole("link").first().click();
  await expect(page.getByTestId("enquiry-thread")).toContainText("Price snapshot");
  await expect(page.getByTestId("snapshot-brokerage")).toHaveText("None");
});

test("renter: compare shortlisted listings by real move-in cost", async ({ page }) => {
  await page.goto("/search?category=rent");
  const cards = page.getByTestId("listing-card");
  await cards.filter({ hasText: "Lajpat Nagar" }).first().getByTestId("shortlist-toggle").click();
  await cards.filter({ hasText: "listed by owner" }).first().getByTestId("shortlist-toggle").click();
  await page.goto("/compare");
  const table = page.getByTestId("compare-table");
  await expect(table).toContainText("To move in");
  await expect(table).toContainText("₹1,54,000"); // 38,000 + 2,000 maintenance + 76,000 deposit + 38,000 brokerage
  await expect(table).toContainText("₹72,000"); // Saket: 24,000 + 48,000 deposit, no brokerage
});

test("renter: report a suspicious listing", async ({ page }) => {
  await page.goto("/search?category=rent");
  const fake = page.getByTestId("listing-card").filter({ hasText: "Cheap 2BHK" });
  if ((await fake.count()) === 0) test.skip(true, "suspicious listing already suspended by an earlier admin run");
  await fake.getByRole("link").nth(1).click();
  await expect(page.getByTestId("trust-badges")).toContainText("Charges disclosed");
  await expect(page.getByTestId("badge-owner_authorised")).toHaveCount(0);
  await expect(page.getByTestId("badge-onsite_media")).toHaveCount(0);
  await page.getByTestId("report-open").click();
  await page.getByLabel("Reason").selectOption("fake_photos");
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-done")).toBeVisible();
});
