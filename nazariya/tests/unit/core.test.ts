import { describe, expect, it } from "vitest";
import { auditHash, canonicalJson, GENESIS_HASH } from "@/lib/audit-hash";
import { dirFromYawPitch, positionFromYawPitch, rayRoomHit, uvToYawPitch, validateRoomDims, yawPitchFromDir } from "@/lib/pano-geometry";
import { maskPhone, normalizePhone } from "@/server/auth";
import { sniffMime } from "@/server/media";
import { embedSnippet, hashKey, hostMatches, normalizeDomain, sdkSnippet } from "@/server/studio";

describe("pano geometry", () => {
  const room = { w: 4, d: 5, h: 3, camH: 1.5 };
  it("yaw/pitch ↔ direction round-trips", () => {
    for (const [yaw, pitch] of [[0, 0], [1.2, 0.3], [-2.5, -0.7], [3.0, 1.2]]) {
      const r = yawPitchFromDir(dirFromYawPitch(yaw, pitch));
      expect(r.yaw).toBeCloseTo(yaw, 6);
      expect(r.pitch).toBeCloseTo(pitch, 6);
    }
  });
  it("yaw 0 looks toward -Z and the panorama centre maps to yaw 0", () => {
    expect(dirFromYawPitch(0, 0)[2]).toBeCloseTo(-1);
    expect(uvToYawPitch(0.5, 0.5)).toEqual({ yaw: 0, pitch: 0 });
  });
  it("rays hit the correct wall, floor and ceiling", () => {
    expect(rayRoomHit(dirFromYawPitch(0, 0), room)).toEqual({ t: 2.5, axis: 2 });
    expect(rayRoomHit(dirFromYawPitch(Math.PI / 2, 0), room).t).toBeCloseTo(2);
    expect(rayRoomHit([0, -1, 0], room)).toEqual({ t: 1.5, axis: 1 });
    expect(rayRoomHit([0, 1, 0], room)).toEqual({ t: 1.5, axis: 1 });
  });
  it("hotspot anchors stay inside the room", () => {
    for (let i = 0; i < 50; i++) {
      const p = positionFromYawPitch((i / 50) * 6.28 - 3.14, ((i % 7) - 3) * 0.4, room);
      expect(Math.abs(p[0])).toBeLessThanOrEqual(2);
      expect(Math.abs(p[2])).toBeLessThanOrEqual(2.5);
      expect(p[1]).toBeGreaterThanOrEqual(-1.5);
      expect(p[1]).toBeLessThanOrEqual(1.5);
    }
  });
  it("clamps invalid room dimensions", () => {
    const r = validateRoomDims({ w: 100, d: -3, h: 2, camH: 9 });
    expect(r).toMatchObject({ w: 20, d: 1.5, h: 2.2 });
    expect(r.camH).toBeCloseTo(1.9, 9);
  });
});

describe("phone numbers", () => {
  it("accepts common Indian formats", () => {
    for (const p of ["9876543210", "+91 98765 43210", "09876543210", "+91-9876543210", "919876543210"]) expect(normalizePhone(p)).toBe("+919876543210");
  });
  it("rejects invalid numbers", () => {
    for (const p of ["12345", "5876543210", "+1 415 555 0100", ""]) expect(() => normalizePhone(p)).toThrow();
  });
  it("masks", () => expect(maskPhone("+919876543210")).toBe("+91 98xxxxx210"));
});

describe("embed domain rules", () => {
  it("normalises domains and rejects garbage", () => {
    expect(normalizeDomain("https://WWW.Skyline.in/listing/12")).toBe("www.skyline.in");
    expect(normalizeDomain("*.skyline.in")).toBe("*.skyline.in");
    expect(normalizeDomain("localhost:3100")).toBe("localhost:3100");
    expect(() => normalizeDomain("not a domain!")).toThrow();
    expect(() => normalizeDomain("  ")).toThrow();
  });
  it("matches hosts against the allow-list", () => {
    expect(hostMatches("anything.com", [])).toBe(true);
    expect(hostMatches("skyline.in", ["skyline.in"])).toBe(true);
    expect(hostMatches("evil.com", ["skyline.in"])).toBe(false);
    expect(hostMatches("app.skyline.in", ["*.skyline.in"])).toBe(true);
    expect(hostMatches("skyline.in", ["*.skyline.in"])).toBe(true);
    expect(hostMatches("notskyline.in", ["*.skyline.in"])).toBe(false);
    expect(hostMatches("skyline.in.evil.com", ["skyline.in"])).toBe(false);
  });
});

describe("embed snippets & keys", () => {
  it("iframe snippet points at the embed URL with sane attributes", () => {
    const s = embedSnippet("https://tours.example", "abc123xyz0", 600);
    expect(s).toContain('src="https://tours.example/embed/abc123xyz0"');
    expect(s).toContain('height="600"');
    expect(s).toContain("allowfullscreen");
    expect(s).toContain('loading="lazy"');
  });
  it("SDK snippet loads the SDK and the right space", () => {
    const s = sdkSnippet("https://tours.example", "abc123xyz0");
    expect(s).toContain("https://tours.example/sdk/nazariya.js");
    expect(s).toContain('space: "abc123xyz0"');
  });
  it("API keys are stored as hashes", () => {
    expect(hashKey("nz_live_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey("nz_live_x")).not.toBe(hashKey("nz_live_y"));
  });
});

describe("upload sniffing", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(40).fill(0)]);
  it("recognises images, video and 3D scans by content", () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(sniffMime(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d))).toBe("video/mp4");
    expect(sniffMime(new TextEncoder().encode("ply\nformat binary_little_endian 1.0\n"))).toBe("model/ply");
    expect(sniffMime(bytes(0x1f, 0x8b, 8), "scene.spz")).toBe("model/spz");
    expect(sniffMime(new Uint8Array(64), "scene.splat")).toBe("model/splat");
  });
  it("rejects renamed or unknown content", () => {
    expect(sniffMime(new TextEncoder().encode("hello world, not an image"))).toBeNull();
    expect(sniffMime(bytes(0x1f, 0x8b, 8), "photo.jpg")).toBeNull();
  });
});

describe("audit hashing", () => {
  const p = { occurredAt: "2026-10-15T00:00:00.000Z", actorUserId: null, actorRole: "system", action: "x", subjectType: "space", subjectId: "1", data: { b: 1, a: [1, { d: 2, c: 3 }] } };
  it("canonical JSON is key-order independent", () => expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 })));
  it("hash changes with content or previous hash", () => {
    const h = auditHash(GENESIS_HASH, p);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(auditHash(GENESIS_HASH, { ...p, action: "y" })).not.toBe(h);
    expect(auditHash("1".repeat(64), p)).not.toBe(h);
    expect(auditHash(GENESIS_HASH, { ...p, data: { a: [1, { c: 3, d: 2 }], b: 1 } })).toBe(h);
  });
});
