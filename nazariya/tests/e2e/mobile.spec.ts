import { expect, test } from "@playwright/test";
import { demoPublicId } from "./helpers";

test("mobile: embed fits the screen, rooms are reachable, photo fallback works", async ({ page }) => {
  const id = await demoPublicId(page, /2BHK/);
  await page.goto(`/t/${id}`);
  await expect(page.getByTestId("tour-start")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByTestId("tour-start").click();
  await expect(page.locator("[data-testid=splat-view][data-loaded=true], [data-testid=pano-view]").first()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("room-list").getByRole("tab", { name: /Kitchen/ }).click();
  await expect(page.getByTestId("current-room")).toHaveText("Kitchen");
  await page.goto(`/t/${id}?view=photos&autostart=1`);
  await expect(page.getByTestId("photo-view").locator("img").first()).toBeVisible();
});
