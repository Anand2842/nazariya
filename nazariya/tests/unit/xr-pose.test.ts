import { describe, expect, it } from "vitest";
import { rollOf, type Basis } from "@/lib/orientation";
import type { Vec3 } from "@/lib/pano-geometry";
import { moveHint, moveHintText } from "@/lib/xr-pose";

const D2R = Math.PI / 180;

/** Camera basis for a user facing yaw (clockwise from −z), camera pitched up by `pitch`. */
function basis(yawDeg: number, pitchDeg: number, rollDeg = 0): Basis {
  const y = yawDeg * D2R, p = pitchDeg * D2R, r = rollDeg * D2R;
  const f: Vec3 = [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
  const r0: Vec3 = [Math.cos(y), 0, Math.sin(y)];
  const u0: Vec3 = [r0[1] * f[2] - r0[2] * f[1], r0[2] * f[0] - r0[0] * f[2], r0[0] * f[1] - r0[1] * f[0]];
  // Roll about the forward axis.
  const right: Vec3 = [0, 1, 2].map((i) => r0[i] * Math.cos(r) + u0[i] * Math.sin(r)) as Vec3;
  const up: Vec3 = [0, 1, 2].map((i) => u0[i] * Math.cos(r) - r0[i] * Math.sin(r)) as Vec3;
  return { right, up, forward: f };
}

describe("depth-mode move hint", () => {
  it("speaks in the user's left/right/forward/back, whatever way they face", () => {
    // The spot is 10 cm to the user's left and 6 cm behind them.
    for (const yaw of [0, 90, 200]) {
      const b = basis(yaw, 0);
      const target: Vec3 = [-0.1 * b.right[0] - 0.06 * b.forward[0], 0, -0.1 * b.right[2] - 0.06 * b.forward[2]];
      const h = moveHint([0, 0, 0], target, b);
      expect(h.right).toBeCloseTo(-0.1, 3);
      expect(h.forward).toBeCloseTo(-0.06, 3);
      expect(moveHintText(h)).toBe("10 cm left, 6 cm back");
    }
  });

  it("keeps 'forward' meaning the way the user faces when the camera points up or down", () => {
    for (const pitch of [45, 88, -45, -88]) {
      const b = basis(30, pitch);
      const facing: Vec3 = [Math.sin(30 * D2R), 0, -Math.cos(30 * D2R)];
      const h = moveHint([0, 0, 0], [facing[0] * 0.12, 0.05, facing[2] * 0.12], b);
      expect(h.forward).toBeCloseTo(0.12, 2);
      expect(Math.abs(h.right)).toBeLessThan(0.01);
      expect(moveHintText(h)).toBe("12 cm forward, 5 cm up");
    }
  });

  it("is quiet about tiny offsets", () => {
    expect(moveHintText({ right: 0.01, forward: -0.02, up: 0.005 })).toBe("a little");
  });
});

describe("roll near the zenith", () => {
  it("is meaningless when looking straight up, so the capture gate must not use it", () => {
    // A 2° sideways lean while aiming at the zenith dot (pitch 88°) reads as a large roll.
    const lean = basis(0, 88);
    const tilted: Basis = { ...lean, right: [Math.cos(2 * D2R), Math.sin(2 * D2R), 0] };
    expect(Math.abs(rollOf(tilted)) / D2R).toBeGreaterThan(6);
    // On the horizon the same lean is a 2° roll.
    expect(Math.abs(rollOf(basis(0, 0, 2))) / D2R).toBeCloseTo(2, 1);
  });
});
