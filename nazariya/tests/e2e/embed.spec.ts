import { expect, test } from "@playwright/test";
import { demoPublicId } from "./helpers";

test("embed: tour loads inside an iframe, deep-links to a room and falls back without WebGL", async ({ page }) => {
  const id = await demoPublicId(page, /2BHK/);
  await page.goto(`/embed/${id}`);
  await expect(page.getByTestId("tour-start")).toBeVisible();
  await expect(page.getByTestId("room-list")).toContainText("Kitchen");
  await page.getByTestId("tour-start").click();
  await expect(page.locator("[data-testid=splat-view][data-loaded=true], [data-testid=pano-view]").first()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("tier-360").click();
  await expect(page.getByTestId("pano-view")).toBeVisible();
  await page.getByTestId("room-list").getByRole("tab", { name: /Bedroom/ }).click();
  await expect(page.getByTestId("current-room")).toHaveText("Bedroom");
  await expect(page.getByTestId("powered-by")).toBeVisible();

  await page.goto(`/embed/${id}?view=photos&autostart=1&rooms=0`);
  await expect(page.getByTestId("photo-view").locator("img").first()).toBeVisible();
  await expect(page.getByTestId("tier-3d")).toBeDisabled();
  await expect(page.getByTestId("room-list")).toHaveCount(0);
});

test("embed: SDK on a customer website controls the tour and receives events", async ({ page }) => {
  const id = await demoPublicId(page, /2BHK/);
  await page.goto(`/examples/agency-site.html?space=${id}`);
  await expect(page.getByTestId("host-log")).toContainText("ready: 4 rooms");
  await page.getByTestId("host-rooms").getByRole("button", { name: "Kitchen" }).click();
  await expect(page.getByTestId("host-log")).toContainText("roomchange: Kitchen");
  const frame = page.frameLocator("iframe");
  await expect(frame.getByTestId("current-room")).toHaveText("Kitchen", { timeout: 30_000 });
  await page.getByRole("button", { name: "360°" }).click();
  await expect(frame.getByTestId("pano-view")).toBeVisible();
  await page.getByTestId("host-rooms").getByRole("button", { name: "Bathroom" }).click();
  await expect(frame.getByTestId("current-room")).toHaveText("Bathroom");
  await expect(page.getByTestId("host-log")).toContainText("roomchange: Bathroom");
});

test("embed: domain allow-list and unpublished tours are enforced", async ({ page }) => {
  const villa = await demoPublicId(page, /Villa/);
  const r = await page.request.get(`/embed/${villa}`);
  expect(r.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(r.headers()["content-security-policy"]).toContain("*.skylinehomes.in");
  expect(r.headers()["x-frame-options"]).toBeUndefined();
  const blocked = await page.request.get(`/embed/${villa}`, { headers: { Referer: "https://evil.example/page" } });
  expect(await blocked.text()).toContain("can&#x27;t be embedded on evil.example");
  const open = await demoPublicId(page, /2BHK/);
  expect((await page.request.get(`/embed/${open}`)).headers()["content-security-policy"]).toBe("frame-ancestors *");
  await page.goto("/embed/zzzzzzzzzz");
  await expect(page.getByTestId("tour-unavailable")).toBeVisible();
  const share = await page.request.get(`/t/${open}`);
  expect(share.headers()["x-frame-options"]).toBe("SAMEORIGIN");
});

test("oEmbed returns iframe HTML for a share link", async ({ page }) => {
  const id = await demoPublicId(page, /Hotel/);
  const r = await page.request.get(`/api/oembed?url=${encodeURIComponent(`http://localhost:3100/t/${id}`)}`);
  const j = await r.json();
  expect(j).toMatchObject({ type: "rich", version: "1.0", title: "Hotel Deluxe Room" });
  expect(j.html).toContain(`/embed/${id}`);
});

test("house tour: floor-plan minimap, walking through a door keeps your real-world heading", async ({ page }) => {
  const id = await demoPublicId(page, /2BHK/);
  await page.goto(`/embed/${id}?view=360&autostart=1`);
  await expect(page.getByTestId("pano-view")).toBeVisible({ timeout: 60_000 });
  const map = page.getByTestId("minimap-plan");
  await expect(map).toBeVisible();
  await expect(map.locator('[data-label="Living room"] polygon')).toHaveAttribute("stroke", "#f59e0b"); // current room
  await expect(page.getByTestId("plan-heading")).toBeVisible();
  // Walk through the door to the Bedroom (east of the living room on the plan): turn right by dragging until it shows.
  const door = page.locator(".nz-hs", { hasText: "Bedroom" }).first();
  const box = (await page.getByTestId("pano-view").boundingBox())!;
  for (let i = 0; i < 8 && !(await door.isVisible()); i++) {
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await door.click({ force: true });
  await expect(page.getByTestId("current-room")).toHaveText("Bedroom");
  // Both rooms face the same way on the plan, so you arrive still facing east (yaw ≈ 90°).
  await expect.poll(async () => Number(await page.getByTestId("minimap").getAttribute("data-heading")), { timeout: 15_000 }).toBeGreaterThan(1.2);
  expect(Number(await page.getByTestId("minimap").getAttribute("data-heading"))).toBeLessThan(1.9);
  // Jump by tapping a room on the plan.
  await map.locator('[data-label="Kitchen"]').click();
  await expect(page.getByTestId("current-room")).toHaveText("Kitchen");
  await page.getByTestId("minimap-toggle").click();
  await expect(map).toHaveCount(0);
  // Embeds can hide the plan.
  await page.goto(`/embed/${id}?view=360&autostart=1&map=0`);
  await expect(page.getByTestId("pano-view")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("minimap")).toHaveCount(0);
});
