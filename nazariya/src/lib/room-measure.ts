// Room measurement from phone depth sensing (WebXR depth / ARCore). Input: 3D points in room-local
// coordinates (metres; the camera at the origin, y up, panorama yaw 0 towards −z). Output: a measured box
// (width, depth, height, camera height, box offset and rotation) and a depth panorama for 3D building.
//
// Assumptions, stated plainly: rooms are treated as rectangles (L-shaped rooms get their bounding
// rectangle), walls are vertical, and floor/ceiling are flat. Depth sensors are accurate to a few cm at
// 1–4 m; beyond ~5 m readings get noisy and are ignored.
import type { RoomDims } from "./pano-geometry";

export interface RoomMeasurement {
  dims: RoomDims;
  /** Share of wall points within 12 cm of the fitted walls (0..1): how rectangular/clean the fit is. */
  fit: number;
  floorY: number;
  ceilingY: number;
  points: number;
}

const D2R = Math.PI / 180;
const MAX_RANGE = 5.5;

/**
 * The outermost strong plane in a range: scanning from the far end (`fromHigh`), the first local histogram
 * peak with at least `minShare` of the strongest peak. Floors are the lowest strong horizontal plane (a bed or
 * table top is higher), ceilings the highest, walls the farthest (furniture fronts are nearer).
 */
function extremePeak(values: number[], lo: number, hi: number, bin: number, fromHigh: boolean, minShare = 0.35): number | null {
  if (hi <= lo) return null;
  const n = Math.max(1, Math.ceil((hi - lo) / bin));
  const h = new Array<number>(n).fill(0);
  let any = 0;
  for (const v of values)
    if (v >= lo && v < hi) {
      h[Math.min(n - 1, Math.floor((v - lo) / bin))]++;
      any++;
    }
  if (any < 30) return null;
  const sm = h.map((c, i) => c + 0.5 * ((h[i - 1] ?? 0) + (h[i + 1] ?? 0)));
  const max = Math.max(...sm);
  for (let k = 0; k < n; k++) {
    const i = fromHigh ? n - 1 - k : k;
    if (sm[i] >= minShare * max && sm[i] >= (sm[i - 1] ?? 0) && sm[i] >= (sm[i + 1] ?? 0)) return lo + (i + 0.5) * bin;
  }
  return null;
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** Sharpness of the x and z histograms after rotating the points by −θ: walls aligned with the axes give tall spikes. */
function alignmentScore(xz: Float32Array, n: number, thetaDeg: number): number {
  const c = Math.cos(-thetaDeg * D2R), s = Math.sin(-thetaDeg * D2R);
  const bin = 0.05, off = MAX_RANGE;
  const nb = Math.ceil((2 * off) / bin);
  const hx = new Float32Array(nb), hz = new Float32Array(nb);
  for (let i = 0; i < n; i++) {
    const x = xz[2 * i], z = xz[2 * i + 1];
    const rx = x * c - z * s, rz = x * s + z * c;
    const bx = Math.floor((rx + off) / bin), bz = Math.floor((rz + off) / bin);
    if (bx >= 0 && bx < nb) hx[bx]++;
    if (bz >= 0 && bz < nb) hz[bz]++;
  }
  let sc = 0;
  for (let i = 0; i < nb; i++) sc += hx[i] * hx[i] + hz[i] * hz[i];
  return sc;
}

/** Wall position on one side of the camera along a rotated axis (sign = −1 or +1), or null. */
function wallOnSide(coords: number[], sign: 1 | -1): number | null {
  const at = extremePeak(coords.map((v) => v * sign), 0.3, MAX_RANGE, 0.04, true);
  return at === null ? null : sign * at;
}

export function measureRoom(points: Float32Array): RoomMeasurement | null {
  const n = Math.floor(points.length / 3);
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
    if (Number.isFinite(y) && Math.hypot(x, z) < MAX_RANGE) ys.push(y);
  }
  if (ys.length < 500) return null;
  const sorted = [...ys].sort((a, b) => a - b);
  // Floor: the dense horizontal plane below the camera; ceiling: the one above.
  const floor = extremePeak(ys, percentile(sorted, 0) - 0.01, -0.6, 0.02, false) ?? percentile(sorted, 0.02);
  const ceil = extremePeak(ys, 0.4, percentile(sorted, 1) + 0.01, 0.02, true) ?? percentile(sorted, 0.98);
  const h = ceil - floor;
  if (!(h > 1.9 && h < 6.5)) return null;

  // Wall points: away from floor/ceiling and from the phone itself.
  const xz: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
    const r = Math.hypot(x, z);
    if (y > floor + 0.25 && y < ceil - 0.25 && r > 0.4 && r < MAX_RANGE) xz.push(x, z);
  }
  const m = xz.length / 2;
  if (m < 300) return null;
  const arr = Float32Array.from(xz);
  let bestT = 0, bestS = -1;
  for (let t = 0; t < 90; t += 1) {
    const s = alignmentScore(arr, m, t);
    if (s > bestS) [bestT, bestS] = [t, s];
  }
  for (let t = bestT - 1; t <= bestT + 1; t += 0.1) {
    const s = alignmentScore(arr, m, t);
    if (s > bestS) [bestT, bestS] = [t, s];
  }
  const c = Math.cos(-bestT * D2R), s = Math.sin(-bestT * D2R);
  const rx: number[] = [], rz: number[] = [];
  for (let i = 0; i < m; i++) {
    const x = arr[2 * i], z = arr[2 * i + 1];
    rx.push(x * c - z * s);
    rz.push(x * s + z * c);
  }
  const x0 = wallOnSide(rx, -1), x1 = wallOnSide(rx, 1), z0 = wallOnSide(rz, -1), z1 = wallOnSide(rz, 1);
  if (x0 === null || x1 === null || z0 === null || z1 === null) return null;
  let near = 0;
  for (let i = 0; i < m; i++) {
    const dx = Math.min(Math.abs(rx[i] - x0), Math.abs(rx[i] - x1)), dz = Math.min(Math.abs(rz[i] - z0), Math.abs(rz[i] - z1));
    if (Math.min(dx, dz) < 0.12) near++;
  }
  // Box centre in room-local coordinates (rotate the rotated-frame centre back by +θ).
  const ccx = (x0 + x1) / 2, ccz = (z0 + z1) / 2;
  const cb = Math.cos(bestT * D2R), sb = Math.sin(bestT * D2R);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    dims: {
      w: round(x1 - x0),
      d: round(z1 - z0),
      h: round(h),
      camH: round(-floor),
      cx: round(ccx * cb - ccz * sb),
      cz: round(ccx * sb + ccz * cb),
      rotDeg: round(bestT),
      measured: true,
    },
    fit: Math.round((near / m) * 100) / 100,
    floorY: floor,
    ceilingY: ceil,
    points: n,
  };
}

/**
 * Depth panorama (equirect, W × W/2, metres from the camera; NaN where nothing was measured): the median
 * distance of the points seen in each direction. Used to give 3D rooms their real shape (furniture, alcoves).
 */
export function depthPanorama(points: Float32Array, W = 256): Float32Array {
  const H = W / 2;
  const buckets: number[][] = Array.from({ length: W * H }, () => []);
  const n = Math.floor(points.length / 3);
  for (let i = 0; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
    const r = Math.hypot(x, y, z);
    if (!(r > 0.3 && r < MAX_RANGE + 1)) continue;
    const yaw = Math.atan2(x, -z), pitch = Math.asin(y / r);
    const u = Math.min(W - 1, Math.floor((yaw / (2 * Math.PI) + 0.5) * W)), v = Math.min(H - 1, Math.floor((0.5 - pitch / Math.PI) * H));
    buckets[v * W + u].push(r);
  }
  const out = new Float32Array(W * H).fill(NaN);
  buckets.forEach((b, k) => {
    if (b.length >= 2) {
      b.sort((a, c) => a - c);
      out[k] = b[b.length >> 1];
    }
  });
  return out;
}

/** Sample a depth panorama (nearest bucket, NaN if unknown) for a unit direction. */
export function sampleDepth(depth: Float32Array, W: number, dir: [number, number, number]): number {
  const H = W / 2;
  const yaw = Math.atan2(dir[0], -dir[2]), pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  const u = Math.min(W - 1, Math.floor((yaw / (2 * Math.PI) + 0.5) * W)), v = Math.min(H - 1, Math.max(0, Math.floor((0.5 - pitch / Math.PI) * H)));
  return depth[v * W + u];
}
