import path from "node:path";
import { expect, test } from "@playwright/test";
import { login, newPhone } from "./helpers";

test("studio: create a workspace, build a tour from a 360° image, publish and get embed code + API access", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await login(page, newPhone());
  await page.goto("/studio");
  await page.getByLabel("Your name").fill("Riya Kapoor");
  await page.getByLabel("Company name").fill("E2E Realty");
  await page.getByTestId("onboarding-submit").click();
  await expect(page.getByTestId("new-space-form")).toBeVisible();

  const name = `E2E Penthouse ${Date.now().toString(36)}`;
  await page.getByLabel("Space name").fill(name);
  await page.getByLabel("Your listing ID").fill("CRM-42");
  await page.getByTestId("new-space-submit").click();
  await expect(page.getByTestId("space-editor")).toBeVisible();
  await expect(page.getByTestId("publish-blockers")).toContainText("at least one room");

  // Room + 360° upload → processing → automatic 3D build.
  await page.getByTestId("room-label").fill("Terrace lounge");
  await page.getByTestId("room-add").click();
  await expect(page.getByTestId("room-tab")).toContainText("Terrace lounge");
  await page.getByTestId("upload-pano").setInputFiles(path.resolve("assets/source/veranda.jpg"));
  await expect(page.getByTestId("editor-msg")).toContainText("uploaded");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("splat-status")).toHaveText("ready", { timeout: 1500 });
  }).toPass({ timeout: 120_000, intervals: [2000] });

  // Place a hotspot by clicking inside the 360° view.
  const pano = page.getByTestId("room-editor").getByTestId("pano-view");
  await expect(pano.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const box = (await pano.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await expect(page.getByTestId("hotspot-form")).toBeVisible();
  await page.getByTestId("hotspot-title").fill("Sunset view");
  await page.getByTestId("hotspot-save").click();
  await expect(page.getByTestId("hotspot-list")).toContainText("Sunset view");

  // 3D preview inside the studio.
  await page.getByTestId("preview-3d").click();
  await expect(page.getByTestId("room-editor").locator("[data-testid=splat-view][data-loaded=true]")).toBeVisible({ timeout: 60_000 });

  // Publish → embed code.
  await page.getByTestId("publish").click();
  await expect(page.getByTestId("space-status")).toHaveText("published");
  const code = await page.getByTestId("embed-code").textContent();
  const publicId = code!.match(/\/embed\/([a-z0-9]+)/)![1];
  expect(code).toContain("<iframe");
  await page.getByTestId("embed-tab-sdk").click();
  await expect(page.getByTestId("embed-code")).toContainText("Nazariya.embed");

  // The share page works for anonymous visitors.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  await visitor.goto(`/t/${publicId}`);
  await visitor.getByTestId("tour-start").click();
  await expect(visitor.locator("[data-testid=splat-view][data-loaded=true], [data-testid=pano-view]").first()).toBeVisible({ timeout: 60_000 });
  await expect(visitor.getByTestId("current-room")).toHaveText("Terrace lounge");

  // Domain allow-list → CSP header.
  await page.getByTestId("domains-input").fill("e2e-realty.example, *.e2e-realty.example");
  await page.getByTestId("domains-save").click();
  await expect(page.getByTestId("embed-panel").getByTestId("action-msg")).toContainText("saved");
  await expect(async () => {
    const r = await visitor.request.get(`/embed/${publicId}`);
    expect(r.headers()["content-security-policy"]).toContain("https://e2e-realty.example");
  }).toPass({ timeout: 45_000, intervals: [3000] });
  await anon.close();

  // API key → REST API.
  await page.goto("/studio/settings");
  await page.getByLabel("Key name").fill("Website");
  await page.getByTestId("create-key").click();
  const key = (await page.getByTestId("new-key-value").textContent())!;
  const api = await page.request.get("/api/v1/spaces?externalRef=CRM-42", { headers: { Authorization: `Bearer ${key}` } });
  expect(api.ok()).toBeTruthy();
  const body = await api.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ id: publicId, name, rooms: 1, rooms3d: 1 });
  const bad = await page.request.get("/api/v1/spaces", { headers: { Authorization: "Bearer nz_live_invalidinvalidinvalidinvalid" } });
  expect(bad.status()).toBe(401);

  // The dashboard shows the space with its stats.
  await page.goto("/studio");
  await expect(page.getByTestId("space-grid")).toContainText(name);
});
