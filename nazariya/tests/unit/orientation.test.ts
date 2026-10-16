import { describe, expect, it } from "vitest";
import { anglesFor, angleBetween, angularSpreadDeg, basisAt, deviceBasisEarth, headingOf, nearestSample, nextTarget, panoTargets, pitchOf, rollOf, tourBasis, yawOf, type OrientationSample, type Target } from "@/lib/orientation";

const deg = (r: number) => (r * 180) / Math.PI;

describe("device orientation → camera basis", () => {
  it("phone upright, alpha 0: camera looks north, top of phone is up", () => {
    const b = deviceBasisEarth({ alpha: 0, beta: 90, gamma: 0 });
    expect(b.forward[1]).toBeCloseTo(1); // north
    expect(b.up[2]).toBeCloseTo(1); // up
    expect(b.right[0]).toBeCloseTo(1); // east
  });
  it("phone flat on a table looks at the floor", () => {
    expect(deviceBasisEarth({ alpha: 0, beta: 0, gamma: 0 }).forward[2]).toBeCloseTo(-1);
  });
  it("landscape screen rotation swaps image axes", () => {
    const b = deviceBasisEarth({ alpha: 0, beta: 90, gamma: 0, screenAngle: 90 });
    expect(Math.abs(b.up[0])).toBeCloseTo(1);
  });
  it("anglesFor produces the requested yaw/pitch relative to the first heading", () => {
    const ref = headingOf(anglesFor(0, 0, 123));
    for (const [y, p] of [[0, 0], [90, 0], [-45, 30], [200, -45], [30, 80]]) {
      const b = tourBasis(anglesFor(y, p, 123), ref);
      expect(((deg(yawOf(b.forward)) - y + 540) % 360) - 180).toBeCloseTo(0, 4);
      expect(deg(pitchOf(b.forward))).toBeCloseTo(p, 4);
      expect(deg(rollOf(b))).toBeCloseTo(0, 4);
    }
  });
  it("rotating the camera about its viewing axis is measured as roll", () => {
    const b = tourBasis({ alpha: 0, beta: 90, gamma: 0 }, 0);
    const a = (10 * Math.PI) / 180;
    // Tilt the image 10° clockwise: right/up rotate in the image plane.
    const right = b.right.map((v, i) => v * Math.cos(a) - b.up[i] * Math.sin(a)) as [number, number, number];
    const up = b.up.map((v, i) => v * Math.cos(a) + b.right[i] * Math.sin(a)) as [number, number, number];
    expect(Math.abs(deg(rollOf({ forward: b.forward, right, up })))).toBeCloseTo(10, 4);
    expect(deg(rollOf(b))).toBeCloseTo(0, 6);
  });
});

describe("360° capture plan", () => {
  it("has 30 targets covering the sphere with overlap", () => {
    const t = panoTargets();
    expect(t).toHaveLength(30);
    expect(t.filter((x) => x.ring === "horizon")).toHaveLength(12);
    const dir = (x: { yaw: number; pitch: number }): [number, number, number] => [Math.sin(x.yaw) * Math.cos(x.pitch), Math.sin(x.pitch), -Math.cos(x.yaw) * Math.cos(x.pitch)];
    // Every point on the sphere is within ~35° of some target (portrait phone half-FOV ≈ 19–32°, plus overlap).
    for (let i = 0; i < 400; i++) {
      const p = { yaw: Math.random() * 2 * Math.PI, pitch: Math.asin(Math.random() * 2 - 1) };
      const best = Math.min(...t.map((x) => angleBetween(dir(x), dir(p))));
      expect(deg(best)).toBeLessThan(36);
    }
  });
});

describe("live capture guide", () => {
  it("an upright phone's wildly different alpha/gamma pairs describe the same camera direction (gimbal lock)", () => {
    // Readings like the ones a real Android phone sent while held upright: alpha and gamma trade off.
    const a = tourBasis({ alpha: 30, beta: 90, gamma: 0 }, 0);
    const b = tourBasis({ alpha: 100, beta: 90, gamma: -70 }, 0);
    expect(deg(angleBetween(a.forward, b.forward))).toBeLessThan(1e-6);
    expect(deg(angleBetween(a.up, b.up))).toBeLessThan(1e-6);
  });

  it("looks up where the phone pointed when a camera frame was captured (interpolating between readings)", () => {
    const ref = headingOf(anglesFor(0, 0, 50));
    const s: OrientationSample[] = [0, 1, 2, 3].map((k) => ({ t: 1000 + k * 100, a: anglesFor(k * 10, 0, 50) }));
    expect(nearestSample(s, 1149)).toBe(1);
    expect(nearestSample(s, 1151)).toBe(2);
    const mid = basisAt(s, 1150, ref)!;
    expect(deg(yawOf(mid.forward))).toBeCloseTo(15, 1);
    expect(deg(rollOf(mid))).toBeCloseTo(0, 4);
    // The camera image lags the sensor: 100 ms ago the phone pointed 10° further left than now.
    expect(deg(yawOf(basisAt(s, 1200, ref)!.forward))).toBeCloseTo(20, 4);
    expect(basisAt([], 0, 0)).toBeNull();
  });

  it("treats sensor noise as still but catches slow drift and fast turns", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2; // ±0.1°
    const still = Array.from({ length: 20 }, (_, k) => ({ t: k * 16, a: anglesFor(30 + rnd(), 5 + rnd(), 0) }));
    expect(angularSpreadDeg(still, 19 * 16)).toBeLessThan(0.6);
    const drifting = Array.from({ length: 20 }, (_, k) => ({ t: k * 16, a: anglesFor(30 + k * 0.1, 5, 0) })); // 6°/s
    expect(angularSpreadDeg(drifting, 19 * 16)).toBeGreaterThan(0.6);
    const twisting = Array.from({ length: 20 }, (_, k) => ({ t: k * 16, a: { ...anglesFor(30, 5, 0), gamma: k * 0.2 } }));
    expect(angularSpreadDeg(twisting, 19 * 16)).toBeGreaterThan(0.6);
    expect(angularSpreadDeg(still.slice(0, 1), 0)).toBe(Infinity);
  });

  it("shows one target at a time: clockwise along a row, then the next row from where the camera points", () => {
    const t = panoTargets();
    const done = new Set<number>();
    const order: number[] = [];
    let last: number | null = null;
    for (let k = 0; k < t.length; k++) {
      const n: Target = nextTarget(t, done, last, last ?? 0)!;
      order.push(n.id);
      done.add(n.id);
      last = n.yaw;
    }
    expect(nextTarget(t, done, last, 0)).toBeNull();
    expect(order.slice(0, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(order).size).toBe(30);
    // Upper row starts next to the last horizon shot (330°) and continues clockwise.
    const up = order.slice(12, 20).map((id) => deg(t[id].yaw));
    expect(up[0]).toBeCloseTo(337.5, 6);
    for (let k = 1; k < up.length; k++) expect((up[k] - up[k - 1] + 360) % 360).toBeCloseTo(45, 6);
  });
});
