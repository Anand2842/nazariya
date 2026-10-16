import { expect, test } from "@playwright/test";
import path from "node:path";
import { login, newPhone, testPhoto } from "./helpers";

test("lister: onboard, create a property, price it, capture rooms, get owner approval and publish", async ({ page }) => {
  test.setTimeout(240_000);
  const title = `E2E sunny 2BHK ${Date.now().toString(36)}`;
  await login(page, newPhone());
  await page.goto("/dashboard");
  await page.getByLabel(/Your full name/).fill("Kavya Mehra");
  await page.getByLabel("Business or display name").fill("Mehra Realty");
  await page.getByTestId("onboarding-submit").click();
  await expect(page.getByTestId("add-property")).toBeVisible();
  await expect(page.getByTestId("kyc-nudge")).toBeVisible();

  await page.getByTestId("add-property").click();
  await page.getByTestId("cat-apartment").click();
  await page.getByLabel("Locality").selectOption("rajouri-garden");
  await page.getByLabel(/Full address/).fill("H-21, Rajouri Garden, near Main Market");
  await page.getByLabel("Owner name").fill("Suresh Mehra");
  await page.getByLabel("Owner phone").fill(newPhone());
  await page.getByTestId("property-submit").click();
  await expect(page.getByTestId("listing-form")).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("Corner flat with good light, two bathrooms and a modular kitchen.");
  await page.getByTestId("listing-submit").click();

  // Draft: publishing is blocked with clear reasons.
  await expect(page.getByTestId("listing-editor")).toBeVisible();
  const blockers = page.getByTestId("publish-blockers");
  await expect(blockers).toContainText("owner has not confirmed");
  await expect(blockers).toContainText("price plan");

  // Pricing: brokerage "none" + deposit default are pre-filled; set the rent.
  await page.getByTestId("add-plan").click();
  await page.getByTestId("plan-rent").fill("27000");
  await page.getByTestId("plan-save").click();
  await expect(page.getByTestId("pricing-editor").getByTestId("price-base")).toHaveText("₹27,000");

  // Availability.
  await page.getByTestId("unit-availability-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("availability-panel").getByTestId("panel-msg")).toContainText("Availability updated");

  // Capture: one room with a 360° pano and three photos.
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 28.6415, longitude: 77.1209 });
  await page.getByTestId("zone-label").fill("Living room");
  await page.getByTestId("zone-add").click();
  await expect(page.getByTestId("tour-editor")).toContainText("Living room");
  await page.getByTestId("upload-pano").setInputFiles(path.resolve("assets/source/veranda.jpg"));
  await expect(page.getByTestId("tour-msg")).toContainText("uploaded", { timeout: 60_000 });
  for (const i of [1, 2, 3]) {
    await page.getByTestId("upload-photo").setInputFiles({ name: `room-${i}.jpg`, mimeType: "image/jpeg", buffer: await testPhoto(Date.now() + i) });
    await expect(page.getByTestId("tour-msg")).toContainText(`room-${i}.jpg uploaded`, { timeout: 60_000 });
  }
  // Wait for the worker to process uploads.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("media-list")).not.toContainText(/uploaded|processing/);
    await expect(page.getByTestId("media-list")).toContainText("pano · ready");
  }).toPass({ timeout: 90_000, intervals: [2000] });

  // Build a 3D walkthrough from the 360° capture.
  await page.getByTestId("build-3d").click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("splat-status")).toHaveText("ready");
  }).toPass({ timeout: 90_000, intervals: [2000] });

  // Owner confirmation through the link the owner receives on WhatsApp (dev outbox).
  await page.getByTestId("ask-owner").click();
  await expect(page.getByTestId("authorization-panel").getByTestId("panel-msg")).toContainText("sent to the owner");
  await page.goto("/dev/outbox");
  await page.getByTestId("outbox").locator("li").filter({ hasText: "H-21, Rajouri Garden" }).first().getByRole("link").click();
  await page.getByTestId("owner-send").click();
  const code = (await page.getByTestId("owner-dev-code").textContent())!;
  await page.getByTestId("owner-code").fill(code);
  await page.getByTestId("owner-accept").click();
  await expect(page.getByTestId("owner-result")).toContainText("confirmed");

  // Publish.
  await page.goto("/dashboard");
  await page.getByTestId("listings-table").getByRole("link", { name: title }).click();
  await expect(page.getByTestId("auth-status")).toHaveText("active");
  await page.getByTestId("publish").click();
  await expect(page.getByTestId("editor-status")).toHaveText("published");

  // It is live, shows a 3D tour and the right price.
  await page.goto("/search?locality=rajouri-garden");
  const card = page.getByTestId("listing-card").filter({ hasText: title });
  await expect(card).toContainText("3D tour");
  await expect(card).toContainText("₹27,000");
  await card.getByRole("link").nth(1).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("badge-onsite_media")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000, intervals: [1500] });
});

test("lister: reply to an enquiry and propose a visit slot", async ({ page }) => {
  await login(page, "9000000003"); // Meera (PG operator) has a seeded enquiry
  await page.goto("/dashboard/enquiries");
  await page.getByTestId("inbox").getByRole("link").first().click();
  await expect(page.getByTestId("enquiry-thread")).toBeVisible();
  await page.getByTestId("message-input").fill("Yes, the bed is available from the 21st. Come by any time after 11 am.");
  await page.getByTestId("message-send").click();
  await expect(page.getByTestId("messages")).toContainText("available from the 21st");
  const inThreeDays = new Date(Date.now() + 3 * 86400_000);
  inThreeDays.setHours(15, 0, 0, 0);
  const local = new Date(inThreeDays.getTime() - inThreeDays.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByTestId("slot-input").first().fill(local);
  await page.getByTestId("slots-submit").click();
  await expect(page.getByTestId("visits")).toContainText("proposed");
});
