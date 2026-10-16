// Panorama → Gaussian-splat scene (".spz") generator.
//
// Each panorama pixel becomes a Gaussian placed where its viewing ray meets an assumed box-shaped room
// (see lib/pano-geometry). From the capture point it reproduces the panorama exactly; small head
// movements show plausible parallax. Scale is ARBITRARY: such scenes must never be used to measure.
// The real phone-video pipeline (SfM + gsplat/Brush on a GPU worker) produces scenes through the same
// downstream path (SPZ asset → zone → viewer).
import { SpzWriter } from "@sparkjsdev/spark";
import { rayRoomHit, toBoxFrame, uvToYawPitch, dirFromYawPitch, type RoomDims } from "@/lib/pano-geometry";
import { sampleDepth } from "@/lib/room-measure";
import { sampleEquirect, type RawImage } from "./image";

export interface SplatBuildResult {
  bytes: Uint8Array;
  splats: number;
}

/**
 * @param sampleWidth horizontal sample count (e.g. 1024 desktop, 512 mobile). Rows are thinned near the
 *                    poles in proportion to cos(pitch) so splat density is roughly uniform on the sphere.
 */
export async function buildSplatFromPano(pano: RawImage, room: RoomDims, sampleWidth: number, depth: { data: Float32Array; W: number } | null = null): Promise<SplatBuildResult> {
  // Splat discs lie in the (possibly rotated) box planes: rotate their local axes by the box rotation.
  const half = (((room.rotDeg ?? 0) * Math.PI) / 180) / 2;
  const quat: [number, number, number, number] = [0, -Math.sin(half), 0, Math.cos(half)];
  const W = sampleWidth;
  const H = Math.round(sampleWidth / 2);
  const positions: number[] = [];
  const colors: number[] = [];
  const scales: number[] = [];
  const px = [0, 0, 0];
  // Arc spacing between neighbouring samples (rows and thinned columns are both ≈ 2π/W on the sphere).
  const spacing = (2 * Math.PI) / W;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const { pitch } = uvToYawPitch(0.5, v);
    const keep = Math.max(1, Math.round(W * Math.cos(pitch)));
    for (let k = 0; k < keep; k++) {
      const u = (k + 0.5) / keep;
      const { yaw } = uvToYawPitch(u, v);
      const d = dirFromYawPitch(yaw, pitch);
      const box = rayRoomHit(d, room);
      const { axis } = box;
      let t = box.t;
      if (!Number.isFinite(t)) continue;
      // Measured depth wins where it exists and is plausible (in front of the walls, not inside the phone).
      if (depth) {
        const m = sampleDepth(depth.data, depth.W, d);
        if (Number.isFinite(m) && m > 0.3 && m < t + 0.15) t = m;
      }
      sampleEquirect(pano, u, v, px);
      positions.push(d[0] * t, d[1] * t, d[2] * t);
      colors.push(px[0] / 255, px[1] / 255, px[2] / 255);
      // Each splat is a thin disc on the surface it lies on. Its footprint grows at grazing angles
      // (floor/ceiling far away, walls seen edge-on), otherwise gaps appear as rings.
      const cosInc = Math.max(0.18, Math.abs(toBoxFrame(d, room)[axis]));
      const s = Math.min(t * spacing * 6, (t * spacing) / cosInc) * 0.9;
      const thin = Math.max(0.0015, t * spacing * 0.08);
      scales.push(axis === 0 ? thin : s, axis === 1 ? thin : s, axis === 2 ? thin : s);
    }
  }
  const n = positions.length / 3;
  const writer = new SpzWriter({ numSplats: n, shDegree: 0, fractionalBits: 12, flagAntiAlias: false });
  for (let i = 0; i < n; i++) {
    writer.setCenter(i, positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    writer.setAlpha(i, 0.97);
    writer.setRgb(i, colors[3 * i], colors[3 * i + 1], colors[3 * i + 2]);
    writer.setScale(i, scales[3 * i], scales[3 * i + 1], scales[3 * i + 2]);
    writer.setQuat(i, quat[0], quat[1], quat[2], quat[3]);
  }
  const bytes = await writer.finalize();
  return { bytes, splats: n };
}
