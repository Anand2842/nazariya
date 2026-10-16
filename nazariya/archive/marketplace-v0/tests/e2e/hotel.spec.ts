import { expect, test } from "@playwright/test";
import { login, newPhone } from "./helpers";

const iso = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);

test("hotel: live quote, sold-out dates and booking request", async ({ page }) => {
  await login(page, newPhone());
  await page.goto("/search?category=short_stay");
  await page.getByTestId("listing-card").filter({ hasText: "Karol Residency" }).getByRole("link").nth(1).click();
  await expect(page.getByTestId("hotel-calendar")).toContainText("Sold out");
  await page.getByLabel("Room type").selectOption({ index: 0 });
  await page.getByLabel("Check-in").fill(iso(9));
  await page.getByLabel("Check-out").fill(iso(12));
  await expect(page.getByTestId("stay-unavailable")).toContainText("Sold out");
  await expect(page.getByTestId("booking-submit")).toBeDisabled();
  await page.getByLabel("Check-in").fill(iso(20));
  await page.getByLabel("Check-out").fill(iso(22));
  await expect(page.getByTestId("stay-total")).toHaveText("₹5,880"); // 2 × 2,800 + 5%
  await page.getByTestId("booking-submit").click();
  await expect(page.getByTestId("enquiry-done")).toContainText("Booking request sent");
  await page.goto("/me");
  await expect(page.getByTestId("my-bookings")).toContainText("Deluxe Double");
});
