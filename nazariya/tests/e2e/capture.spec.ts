import { expect, test, type Page } from "@playwright/test";
import { anglesFor, panoTargets } from "../../src/lib/orientation";
import { installFakeXR } from "./fake-xr";
import { login, PHONES } from "./helpers";

async function openDraftSpace(page: Page) {
  await login(page, PHONES.customer);
  await page.goto("/studio");
  await page.getByTestId("space-card").filter({ hasText: "Tower B" }).click();
  await expect(page.getByTestId("room-editor")).toBeVisible();
}

/** Simulated gyroscope: dispatch deviceorientation events at 30 Hz from window.__o. */
async function installGyro(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __o: { alpha: number; beta: number; gamma: number }; __gyro?: number };
    w.__o = { alpha: 0, beta: 90, gamma: 0 };
    w.__gyro = window.setInterval(() => window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { ...w.__o, absolute: false })), 33);
  });
}
async function point(page: Page, o: { alpha: number; beta: number; gamma: number }) {
  await page.evaluate((v) => ((window as unknown as { __o: typeof v }).__o = v), o);
}

test("guided photos: live camera, shot list and upload from the studio", async ({ page }) => {
  await openDraftSpace(page);
  await page.getByTestId("open-capture").click();
  await expect(page.getByTestId("capture-studio")).toBeVisible();
  await page.getByTestId("capture-mode-photos").click();
  await expect(page.getByTestId("capture-intro")).toContainText("Guided photos");
  await page.getByTestId("capture-start").click();
  await expect(page.getByTestId("shot-guide")).toContainText("Shot 1");
  await expect.poll(() => page.getByTestId("camera-video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId("quality-chips")).toContainText(/Light|dark|bright/);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("shutter").click();
    await page.waitForTimeout(300);
  }
  await expect(page.getByTestId("shot-guide")).toContainText("Shot 4");
  await page.getByTestId("photos-upload").click();
  await expect(page.getByTestId("capture-done")).toContainText("3 photos");
  await page.getByTestId("capture-close").click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("media-list")).toContainText("📷 photo · ready", { timeout: 1500 });
  }).toPass({ timeout: 60_000, intervals: [2000] });
});

test("guided 360° on a phone via capture link: auto-capture → stitch → 360° + 3D room", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await openDraftSpace(page);
  await page.getByTestId("phone-capture-create").click();
  const url = (await page.getByTestId("phone-capture-url").textContent())!;
  await expect(page.getByTestId("phone-capture-qr")).toBeVisible();

  // The phone: no login, mobile viewport, fake camera, simulated gyroscope.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["camera"] });
  const p = await phone.newPage();
  await p.goto(url);
  await expect(p.getByTestId("capture-intro")).toContainText("360° capture");
  await installGyro(p);
  const a0 = 140;
  await point(p, anglesFor(0, 0, a0));
  await p.getByTestId("capture-start").click();
  await expect.poll(() => p.getByTestId("camera-video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await p.getByTestId("pano-begin").click();
  // The first photo is taken automatically once the phone is level and still.
  await expect(p.getByTestId("pano-progress")).toHaveText("1/30", { timeout: 8000 });
  // One dot at a time: point where the guide says, hold still, and it captures.
  const all = panoTargets();
  let prev = "0";
  for (let n = 2; n <= 30; n++) {
    // Wait for the guide to move on from the dot just captured.
    await expect(p.getByTestId("pano-guide")).not.toHaveAttribute("data-next-target", prev);
    prev = (await p.getByTestId("pano-guide").getAttribute("data-next-target"))!;
    const id = Number(prev);
    const t = all[id];
    await point(p, anglesFor((t.yaw * 180) / Math.PI, (t.pitch * 180) / Math.PI, a0));
    await expect(p.getByTestId("pano-progress")).toHaveText(`${n}/30`, { timeout: 8000 });
  }
  await expect(p.getByTestId("pano-guide")).toContainText("All done");
  await p.getByTestId("pano-upload").click();
  await expect(p.getByTestId("capture-done")).toContainText("360° capture", { timeout: 60_000 });
  await phone.close();

  // Back in the studio: the room gets a stitched 360° and then an automatic 3D walkthrough.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("splat-status")).toHaveText("ready", { timeout: 1500 });
    await expect(page.getByTestId("media-list")).toContainText("📷 pano · ready", { timeout: 1500 });
  }).toPass({ timeout: 150_000, intervals: [3000] });
});

test("guided walkthrough video records in the browser and uploads", async ({ page }) => {
  test.setTimeout(120_000);
  await openDraftSpace(page);
  await page.getByTestId("open-capture").click();
  await page.getByTestId("capture-mode-video").click();
  await page.getByTestId("capture-start").click();
  await expect.poll(() => page.getByTestId("camera-video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await page.getByTestId("record").click();
  await expect(page.getByTestId("video-timer")).toContainText("●");
  await page.waitForTimeout(11_500);
  await expect(page.getByTestId("video-tip")).toContainText("Lap 1");
  await page.getByTestId("record").click();
  await expect(page.getByTestId("video-preview")).toBeVisible();
  await expect(page.getByTestId("video-framed")).toContainText("Well filmed");
  await page.getByTestId("video-upload").click();
  await expect(page.getByTestId("capture-done")).toContainText("Walkthrough");
});

test("expired or invalid capture links are refused", async ({ page }) => {
  await page.goto("/capture/thisisnotavalidtokenatall123");
  await expect(page.getByTestId("capture-link-invalid")).toBeVisible();
  const r = await page.request.post("/api/uploads", { headers: { "x-capture-token": "thisisnotavalidtokenatall123" }, multipart: { kind: "photo" } });
  expect(r.status()).toBe(401);
});

test("depth mode keeps capturing when AR tracking drifts (seen on a real phone), and doesn't fake measurements", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await openDraftSpace(page);
  await page.getByTestId("phone-capture-create").click();
  const url = (await page.getByTestId("phone-capture-url").textContent())!;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.addInitScript(installFakeXR);
  await p.goto(url);
  await p.getByTestId("ar-start").click();
  await expect(p.getByTestId("ar-depth-chip")).toContainText("Depth on");
  const name = `AR Drift ${Date.now() % 100000}`;
  await p.getByTestId("ar-new-room").fill(name);
  await p.getByTestId("ar-add-room").click();
  await expect(p.getByTestId("ar-room").locator("option:checked")).toHaveText(name);
  const set = (o: { pos?: number[]; yaw: number; pitch: number; drift?: number[] }) =>
    p.evaluate((v) => Object.assign((window as unknown as { __xr: object }).__xr, v), { ...o, yaw: (o.yaw * Math.PI) / 180, pitch: (o.pitch * Math.PI) / 180 });
  const origin = [0, 0, 0];
  await set({ pos: origin, yaw: 0, pitch: 0 });
  await p.getByTestId("ar-begin-room").click();
  const all = panoTargets();
  let prev = "";
  for (let n = 1; n <= 30; n++) {
    await expect(p.getByTestId("ar-guide")).not.toHaveAttribute("data-next-target", prev);
    prev = (await p.getByTestId("ar-guide").getAttribute("data-next-target"))!;
    const t = all[Number(prev)];
    // As logged on the real phone: after the first row the reported position slides away by metres (0.8 → 3 m)
    // and once jumps, while the user stands still.
    const k = Math.max(0, n - 12);
    const drift = n === 20 ? [2.4, -1.1, 1.6] : [0.17 * k, -0.06 * k, -0.12 * k];
    await set({ yaw: (t.yaw * 180) / Math.PI, pitch: (t.pitch * 180) / Math.PI, drift });
    await expect(p.getByTestId("ar-progress")).toHaveText(`${n}/30`, { timeout: 15_000 });
  }
  // Tracking that keeps resetting is detected, and the standard capture is offered (without blocking this one).
  await expect(p.getByTestId("ar-unstable")).toBeVisible();
  await expect(p.getByTestId("ar-switch-standard")).toBeVisible();
  await p.getByTestId("ar-finish-room").click();
  await expect(p.getByTestId("ar-msg")).toContainText(`${name} uploaded`, { timeout: 60_000 });
  await p.getByTestId("ar-end").click();
  // The phone remembers it, and says so next time depth mode is offered.
  await p.reload();
  await expect(p.getByTestId("ar-unstable-before")).toBeVisible();
  await phone.close();
  // The 360° is built, but the room is not "measured" from drifted positions; the studio says why.
  const room = page.getByTestId("studio-plan").locator(`[data-label="${name}"]`);
  await expect(async () => {
    await page.reload();
    // Processed when this room is on the floor plan.
    await expect(room).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 180_000, intervals: [3000] });
  await expect(page.getByTestId("media-warning").filter({ hasText: "AR tracking drifted" }).first()).toBeVisible();
  await expect(room).not.toContainText("measured");
});

test("depth mode: when AR tracking keeps resetting, one tap switches to the standard 360° capture", async ({ page, browser }) => {
  await openDraftSpace(page);
  await page.getByTestId("phone-capture-create").click();
  const url = (await page.getByTestId("phone-capture-url").textContent())!;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.addInitScript(installFakeXR);
  await p.goto(url);
  await p.getByTestId("ar-start").click();
  await expect(p.getByTestId("ar-room")).toHaveValue(/.+/);
  await p.getByTestId("ar-begin-room").click();
  await expect(p.getByTestId("ar-progress")).toHaveText("1/30", { timeout: 15_000 });
  // Five tracking resets in a few seconds (the world origin jumps by metres).
  for (let k = 1; k <= 5; k++) {
    await p.evaluate((d) => Object.assign((window as unknown as { __xr: object }).__xr, { drift: d }), [k * 1.3, 0, -k]);
    await p.waitForTimeout(300);
  }
  await expect(p.getByTestId("ar-unstable")).toContainText("keeps resetting");
  await p.getByTestId("ar-switch-standard").click();
  await expect(p.getByTestId("capture-done")).toContainText("standard 360° capture");
  await phone.close();
});

test("depth mode on an AR phone: capture two rooms, walk between them → measured floor plan with doors", async ({ page, browser }) => {
  test.setTimeout(420_000);
  await openDraftSpace(page);
  await page.getByTestId("phone-capture-create").click();
  const url = (await page.getByTestId("phone-capture-url").textContent())!;

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await p.addInitScript(installFakeXR);
  await p.goto(url);
  await expect(p.getByTestId("ar-intro")).toContainText("Depth mode available");
  await p.getByTestId("ar-start").click();
  await expect(p.getByTestId("ar-depth-chip")).toContainText("Depth on");

  const setPose = (pos: [number, number, number], yawDeg: number, pitchDeg = 0) =>
    p.evaluate(([pp, y, pi]) => Object.assign((window as unknown as { __xr: object }).__xr, { pos: pp, yaw: (y * Math.PI) / 180, pitch: (pi * Math.PI) / 180 }), [pos, yawDeg, pitchDeg] as const);
  const all = panoTargets();
  // A hand-held phone never stays exactly on the spot: up to ~12 cm of lens movement must still capture.
  const wobble = (n: number): [number, number, number] => [0.12 * Math.sin(n * 1.7), 0.06 * Math.cos(n * 2.3), 0.1 * Math.cos(n * 1.1)].map((v) => Math.max(-0.12, Math.min(0.12, v))) as [number, number, number];
  const captureRoom = async (name: string, type: string, origin: [number, number, number], heading: number, realistic = false) => {
    await p.getByTestId("ar-new-room").fill(name);
    await p.getByLabel("Room type").selectOption(type);
    await p.getByTestId("ar-add-room").click();
    await expect(p.getByTestId("ar-room")).toHaveValue(/.+/);
    await expect(p.getByTestId("ar-room").locator("option:checked")).toHaveText(name);
    await setPose(origin, heading);
    await p.waitForTimeout(200);
    await p.getByTestId("ar-begin-room").click();
    // Like a real phone: missing camera frames and occasional camera/depth read errors must not stall capture.
    await p.evaluate((on) => Object.assign((window as unknown as { __xr: object }).__xr, { flaky: on }), realistic);
    let prev = "";
    for (let n = 1; n <= 30; n++) {
      await expect(p.getByTestId("ar-guide")).not.toHaveAttribute("data-next-target", prev);
      prev = (await p.getByTestId("ar-guide").getAttribute("data-next-target"))!;
      const t = all[Number(prev)];
      const yaw = heading + (t.yaw * 180) / Math.PI, pitch = (t.pitch * 180) / Math.PI;
      if (realistic && n === 6) {
        // 30 cm to the left of the spot: the app says which way to go back, but still takes the photo
        // (position is advice only; blocking on it stalled real phones whose AR position drifted).
        const r = [Math.cos((yaw * Math.PI) / 180), 0, Math.sin((yaw * Math.PI) / 180)];
        await setPose([origin[0] - 0.3 * r[0], origin[1], origin[2] - 0.3 * r[2]], yaw, pitch);
        await expect(p.getByTestId("ar-drift")).toContainText("30 cm right");
        await expect(p.getByTestId("ar-progress")).toHaveText(`${n}/30`, { timeout: 15_000 });
        continue;
      }
      const w = realistic && n > 1 ? wobble(n) : [0, 0, 0];
      await setPose([origin[0] + w[0], origin[1] + w[1], origin[2] + w[2]], yaw, pitch);
      await expect(p.getByTestId("ar-progress")).toHaveText(`${n}/30`, { timeout: 15_000 });
    }
    await p.getByTestId("ar-finish-room").click();
    await expect(p.getByTestId("ar-msg")).toContainText(`${name} uploaded`, { timeout: 60_000 });
  };

  const run = Date.now() % 100000;
  const living = `AR Living ${run}`, bedroom = `AR Bedroom ${run}`;
  await captureRoom(living, "living", [0.4, 0, -0.3], 37, true);
  // Walk through the doorway into the next room (recording keyframes on the way).
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const pos: [number, number, number] = t < 0.5 ? [0.4 + (1.8 - 0.4) * t * 2, 0, -0.3 + 0.3 * t * 2] : [1.8 + (3.3 - 1.8) * (t - 0.5) * 2, 0, 0.2 * (t - 0.5) * 2];
    await setPose(pos, 90);
    await p.waitForTimeout(250);
  }
  await captureRoom(bedroom, "bedroom", [3.3, 0, 0.2], 127);
  await p.getByTestId("ar-end").click();
  await expect(p.getByTestId("capture-done")).toContainText("2 rooms captured in depth mode", { timeout: 60_000 });
  await phone.close();

  // Studio: both rooms measured and placed on the floor plan, connected by doors.
  const plan = page.getByTestId("studio-plan");
  await expect(async () => {
    await page.reload();
    await expect(plan.locator(`[data-label="${living}"]`)).toContainText("measured", { timeout: 1500 });
    await expect(plan.locator(`[data-label="${bedroom}"]`)).toContainText("measured", { timeout: 1500 });
  }).toPass({ timeout: 180_000, intervals: [3000] });
  // The true rooms are 3.6 × 4.2 m and 3.2 × 3.2 m.
  const dims = async (label: string) => {
    const txt = (await plan.locator(`[data-label="${label}"] text`).nth(1).textContent())!;
    const m = /([\d.]+) × ([\d.]+) m/.exec(txt)!;
    return [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
  };
  const [a1, a2] = await dims(living), [b1, b2] = await dims(bedroom);
  expect(Math.abs(a1 - 3.6)).toBeLessThanOrEqual(0.15);
  expect(Math.abs(a2 - 4.2)).toBeLessThanOrEqual(0.15);
  expect(Math.abs(b1 - 3.2)).toBeLessThanOrEqual(0.15);
  expect(Math.abs(b2 - 3.2)).toBeLessThanOrEqual(0.15);
  expect(await plan.getByTestId("plan-door").count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("plan-area")).toContainText("measured with phone depth");
  await expect(page.getByTestId("room-editor")).toContainText("3D walkthrough");
});
