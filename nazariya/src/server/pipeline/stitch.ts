// Sensor-guided panorama stitching: turns ~30 phone photos (each tagged with the gyroscope orientation at
// capture time) into a 2:1 equirectangular 360° image.
//
// 1. Orientation → camera basis per frame (shared math in lib/orientation).
// 2. Field of view: estimated by minimising colour disagreement where neighbouring frames overlap.
// 3. Alignment refinement, coarse to fine: each frame's yaw/pitch/roll is searched (±8° in 1° steps at low
//    resolution, then ±1° in 0.25° steps) against the mosaic built so far, then a global pass re-aligns every
//    frame against all the others. This absorbs gyroscope drift and sensor/camera timing error.
// 4. Exposure: per-frame gain matched to the mosaic in overlaps.
// 5. Centre-weighted blending (the sharpest, most central frame dominates, so parallax shows less ghosting),
//    then pole and hole filling.
import { type Basis, rotateYaw } from "@/lib/orientation";
import type { Vec3 } from "@/lib/pano-geometry";
import type { RawImage } from "./image";

export interface StitchFrame {
  image: RawImage;
  basis: Basis;
}

export interface StitchOptions {
  width?: number; // output width (height = width / 2)
  fovLongDeg?: number; // if omitted, estimated
  fovCandidates?: number[];
  refine?: boolean;
  searchDeg?: number; // coarse search half-range (default 8°)
}

export interface StitchResult {
  pano: RawImage;
  fovLongDeg: number;
  coverage: number; // fraction of the −60°..60° band covered by at least one frame
  adjustments: { dyawDeg: number; dpitchDeg: number; drollDeg: number; gain: number }[];
  bases: Basis[];
  /** 90th percentile of how much overlapping photo pairs still disagree after alignment (degrees). Near 0 for
   *  a phone turned in place; large when the phone moved (parallax) or matched badly. Null without refinement. */
  pairDisagreementP90Deg: number | null;
}

const D2R = Math.PI / 180;

function rotateAbout(v: Vec3, axis: Vec3, ang: number): Vec3 {
  // Rodrigues' rotation formula
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const cr: Vec3 = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return [v[0] * c + cr[0] * s + axis[0] * d * (1 - c), v[1] * c + cr[1] * s + axis[1] * d * (1 - c), v[2] * c + cr[2] * s + axis[2] * d * (1 - c)];
}

/** Apply small yaw (about world up), pitch (about camera right) and roll (about camera forward) corrections. */
export function adjustBasis(b: Basis, dyaw: number, dpitch: number, droll: number): Basis {
  let { forward, right, up } = b;
  if (dyaw) [forward, right, up] = [rotateYaw(forward, dyaw), rotateYaw(right, dyaw), rotateYaw(up, dyaw)];
  if (dpitch) [forward, up] = [rotateAbout(forward, right, dpitch), rotateAbout(up, right, dpitch)];
  if (droll) [right, up] = [rotateAbout(right, forward, -droll), rotateAbout(up, forward, -droll)];
  return { forward, right, up };
}

interface Accum {
  w: number;
  h: number;
  sum: Float32Array; // rgb
  wsum: Float32Array;
}

function newAccum(w: number, h: number): Accum {
  return { w, h, sum: new Float32Array(w * h * 3), wsum: new Float32Array(w * h) };
}

/** Visit every equirect pixel that a frame sees; callback gets pixel index, frame rgb (bilinear) and feather weight. */
function forEachProjected(
  W: number,
  H: number,
  frame: RawImage,
  basis: Basis,
  f: number,
  cb: (idx: number, r: number, g: number, b: number, wgt: number, nx: number, ny: number) => void,
) {
  const { forward: F, right: R, up: U } = basis;
  const fw = frame.width, fh = frame.height, C = frame.channels, data = frame.data;
  const halfW = fw / 2, halfH = fh / 2;
  // Angular radius of the frame (half-diagonal) for cheap rejection.
  const rho = Math.atan(Math.hypot(halfW, halfH) / f) + 0.02;
  const cosLimit = Math.cos(rho);
  const trig = colTrig(W);
  const colSin = trig.sin, colCos = trig.cos;
  // Only visit the equirect rows/columns the frame can touch.
  const pf = Math.asin(Math.max(-1, Math.min(1, F[1])));
  const top = Math.min(Math.PI / 2, pf + rho), bottom = Math.max(-Math.PI / 2, pf - rho);
  const j0 = Math.max(0, Math.floor((0.5 - top / Math.PI) * H) - 1), j1 = Math.min(H - 1, Math.ceil((0.5 - bottom / Math.PI) * H) + 1);
  const extreme = Math.max(Math.abs(top), Math.abs(bottom));
  const sinHalf = extreme >= Math.PI / 2 - 1e-6 ? 2 : Math.sin(rho) / Math.cos(extreme);
  const allCols = sinHalf >= 1;
  const halfCols = allCols ? W : Math.ceil((Math.asin(sinHalf) / (2 * Math.PI)) * W) + 2;
  const yawF = Math.atan2(F[0], -F[2]);
  const ic = Math.round(((yawF / (2 * Math.PI) + 0.5) * W) - 0.5);
  for (let j = j0; j <= j1; j++) {
    const pitch = (0.5 - (j + 0.5) / H) * Math.PI;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const n = allCols ? W : 2 * halfCols + 1;
    for (let c = 0; c < n; c++) {
      const i = allCols ? c : (((ic - halfCols + c) % W) + W) % W;
      const dx = colSin[i] * cp, dy = sp, dz = -colCos[i] * cp;
      const z = dx * F[0] + dy * F[1] + dz * F[2];
      if (z < cosLimit) continue;
      const x = dx * R[0] + dy * R[1] + dz * R[2];
      const y = dx * U[0] + dy * U[1] + dz * U[2];
      const u = (f * x) / z + halfW - 0.5;
      const v = halfH - (f * y) / z - 0.5;
      if (u < 0 || v < 0 || u > fw - 1.001 || v > fh - 1.001) continue;
      const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0;
      const i00 = (v0 * fw + u0) * C, i10 = i00 + C, i01 = i00 + fw * C, i11 = i01 + C;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      const r = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      const g = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      const b = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
      // Feather: weight falls to zero at the frame border.
      const nx = (u - halfW) / halfW, ny = (v - halfH) / halfH;
      const wgt = Math.max(0, (1 - nx * nx) * (1 - ny * ny));
      cb(j * W + i, r, g, b, wgt * wgt + 1e-4, nx, ny);
    }
  }
}

const trigCache = new Map<number, { sin: Float32Array; cos: Float32Array }>();
function colTrig(W: number) {
  let t = trigCache.get(W);
  if (!t) {
    t = { sin: new Float32Array(W), cos: new Float32Array(W) };
    for (let i = 0; i < W; i++) {
      const yaw = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      t.sin[i] = Math.sin(yaw);
      t.cos[i] = Math.cos(yaw);
    }
    trigCache.set(W, t);
  }
  return t;
}

function focal(frame: RawImage, fovLongDeg: number) {
  return Math.max(frame.width, frame.height) / 2 / Math.tan((fovLongDeg * D2R) / 2);
}

/** Rotation vector (axis·angle, world frame) of the rotation taking basis `a` to basis `b`. */
function rotationVectorBetween(a: Basis, b: Basis): Vec3 {
  // M = [right up back] columns; Δ = Mb·Maᵀ.
  const cols = (x: Basis) => [x.right, x.up, [-x.forward[0], -x.forward[1], -x.forward[2]]] as Vec3[];
  const A = cols(a), B = cols(b);
  const d = (r: number, c: number) => B[0][r] * A[0][c] + B[1][r] * A[1][c] + B[2][r] * A[2][c];
  const tr = d(0, 0) + d(1, 1) + d(2, 2);
  const angle = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (angle < 1e-9) return [0, 0, 0];
  const s = 2 * Math.sin(angle);
  return [((d(2, 1) - d(1, 2)) / s) * angle, ((d(0, 2) - d(2, 0)) / s) * angle, ((d(1, 0) - d(0, 1)) / s) * angle];
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
type Level = { W: number; imgs: RawImage[] };

/**
 * Global heading solve. A still phone knows its tilt (pitch/roll) from gravity to about a degree, but its
 * heading comes from integrating the gyroscope and drifts by several degrees. So: for every pair of
 * overlapping frames, measure the heading offset (rotation about world-up, with a small tilt allowance) that
 * best lines frame j up with frame i; then solve all headings together by least squares with a weak pull
 * towards the sensor readings, so no single frame is trusted as the anchor. Pairs that disagree with the
 * solution (blank walls, parallax from moving the phone) are down-weighted.
 */
function solveYaw(sensor: Basis[], [lo, hi]: Level[], fov: number, rangeDeg: number): { yaw: number[]; disagreementP90: number | null } {
  const N = sensor.length;
  const meas: { i: number; j: number; v: number; w: number }[] = [];
  const diag = Math.atan(Math.hypot(lo.imgs[0].width, lo.imgs[0].height) / 2 / focal(lo.imgs[0], fov)) * 2;
  const frameArea = (img: RawImage, W: number) => {
    const f = focal(img, fov);
    return ((2 * Math.atan(img.width / 2 / f)) * (2 * Math.atan(img.height / 2 / f))) / (2 * Math.PI / W) ** 2;
  };
  for (let i = 0; i < N; i++) {
    const acc = [lo, hi].map((L) => {
      const m = newAccum(L.W, L.W / 2);
      forEachProjected(m.w, m.h, L.imgs[i], sensor[i], focal(L.imgs[i], fov), (idx, r, g, b, w) => {
        m.sum[idx * 3] += r * w;
        m.sum[idx * 3 + 1] += g * w;
        m.sum[idx * 3 + 2] += b * w;
        m.wsum[idx] += w;
      });
      return m;
    });
    for (let j = i + 1; j < N; j++) {
      if (angleBetweenVec(sensor[i].forward, sensor[j].forward) > diag * 0.9) continue;
      let best = { y: 0, p: 0 };
      let found = false;
      // Coarse: ±range in 1° steps with ±1° tilt (512 px). Fine: ±0.75° in 0.25° steps (1024 px).
      const plan: { L: Level; m: Accum; yr: number; ys: number; pr: number; ps: number }[] = [
        { L: lo, m: acc[0], yr: rangeDeg, ys: 1, pr: 1, ps: 1 },
        { L: hi, m: acc[1], yr: 0.75, ys: 0.25, pr: 0.5, ps: 0.25 },
      ];
      for (const { L, m, yr, ys, pr, ps } of plan) {
        const img = L.imgs[j], fk = focal(img, fov), minN = 0.08 * frameArea(img, L.W);
        let cand = { ...best, cost: Infinity };
        for (let y = best.y - yr; y <= best.y + yr + 1e-9; y += ys)
          for (let p = best.p - pr; p <= best.p + pr + 1e-9; p += ps) {
            const r = matchError(m, img, adjustBasis(sensor[j], y * D2R, p * D2R, 0), fk);
            const cost = r.err * (1 + 0.002 * y * y + 0.05 * p * p);
            if (r.n >= minN && cost < cand.cost) cand = { y, p, cost };
          }
        if (!Number.isFinite(cand.cost)) break;
        best = { y: cand.y, p: cand.p };
        found = true;
      }
      if (found) meas.push({ i, j, v: best.y, w: 1 });
    }
  }
  // Least squares on headings: Σ w((y_j − y_i) − v)² + λ Σ y².
  const lambda = 0.05;
  let yaw = new Array<number>(N).fill(0);
  for (let iter = 0; iter < 4; iter++) {
    const A = Array.from({ length: N }, () => new Float64Array(N));
    const rhs = new Float64Array(N);
    for (let k = 0; k < N; k++) A[k][k] += lambda;
    for (const m of meas) {
      A[m.j][m.j] += m.w;
      A[m.i][m.i] += m.w;
      A[m.i][m.j] -= m.w;
      A[m.j][m.i] -= m.w;
      rhs[m.j] += m.w * m.v;
      rhs[m.i] -= m.w * m.v;
    }
    yaw = Array.from(solveLinear(A, rhs));
    for (const m of meas) {
      const r = Math.abs(yaw[m.j] - yaw[m.i] - m.v);
      m.w = r <= 1 ? 1 : 1 / r;
    }
  }
  const res = meas.map((m) => Math.abs(yaw[m.j] - yaw[m.i] - m.v)).sort((a, b) => a - b);
  return { yaw, disagreementP90: res.length ? res[Math.min(res.length - 1, Math.floor(res.length * 0.9))] : null };
}

function angleBetweenVec(a: Vec3, b: Vec3) {
  return Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
}

/** Dense Gaussian elimination with partial pivoting (systems here are ~90×90). */
function solveLinear(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    r.set(row);
    r[n] = b[i];
    return r;
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

/** Gain-compensated mean squared colour difference between a frame (at `basis`) and the mosaic where they overlap. */
function matchError(m: Accum, img: RawImage, basis: Basis, f: number) {
  let sff = 0, sfm = 0, smm = 0, sf = 0, sm = 0, n = 0;
  forEachProjected(m.w, m.h, img, basis, f, (idx, r, g, b) => {
    const wm = m.wsum[idx];
    if (wm < 0.05) return;
    const mr = m.sum[idx * 3] / wm, mg = m.sum[idx * 3 + 1] / wm, mb = m.sum[idx * 3 + 2] / wm;
    sff += r * r + g * g + b * b;
    sfm += r * mr + g * mg + b * mb;
    smm += mr * mr + mg * mg + mb * mb;
    sf += r + g + b;
    sm += mr + mg + mb;
    n++;
  });
  if (!n || sf <= 0) return { err: Infinity, n, gain: 1 };
  const gain = Math.min(1.4, Math.max(0.7, sm / sf));
  // Σ(g·f − m)² / 3n
  return { err: (gain * gain * sff - 2 * gain * sfm + smm) / (3 * n), n, gain };
}

/** Downscale a raw image by an integer factor (box filter) for fast low-resolution passes. */
export function downscale(img: RawImage, factor: number): RawImage {
  if (factor <= 1) return img;
  const w = Math.floor(img.width / factor), h = Math.floor(img.height / factor), C = img.channels;
  const out = Buffer.alloc(w * h * 3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < factor; y++)
        for (let x = 0; x < factor; x++) {
          const k = ((j * factor + y) * img.width + (i * factor + x)) * C;
          r += img.data[k];
          g += img.data[k + 1];
          b += img.data[k + 2];
        }
      const n = factor * factor, o = (j * w + i) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  return { data: out, width: w, height: h, channels: 3 };
}

/** Mean squared colour disagreement in overlaps for a given FOV (lower = better). */
export function overlapError(frames: StitchFrame[], fovLongDeg: number, W: number): number {
  const H = W / 2;
  const acc = newAccum(W, H);
  const sq = new Float32Array(W * H);
  for (const fr of frames) {
    forEachProjected(W, H, fr.image, fr.basis, focal(fr.image, fovLongDeg), (idx, r, g, b) => {
      acc.sum[idx * 3] += r;
      acc.sum[idx * 3 + 1] += g;
      acc.sum[idx * 3 + 2] += b;
      sq[idx] += r * r + g * g + b * b;
      acc.wsum[idx] += 1;
    });
  }
  let err = 0, n = 0;
  for (let p = 0; p < W * H; p++) {
    const c = acc.wsum[p];
    if (c < 2) continue;
    const mr = acc.sum[p * 3] / c, mg = acc.sum[p * 3 + 1] / c, mb = acc.sum[p * 3 + 2] / c;
    err += sq[p] / c - (mr * mr + mg * mg + mb * mb);
    n++;
  }
  return n > 50 ? err / n : Infinity;
}

/** Plausible long-side FOV of phone main cameras in video mode. */
export const FOV_RANGE: [number, number] = [56, 78];
export const DEFAULT_FOV = 65;

export function estimateFov(frames: StitchFrame[], candidates = [56, 60, 63, 66, 70, 74, 78]): number {
  const small = frames.map((f) => ({ basis: f.basis, image: downscale(f.image, Math.max(1, Math.round(Math.max(f.image.width, f.image.height) / 256))) }));
  const errs = candidates.map((c) => overlapError(small, c, 512));
  let bestIdx = 0;
  errs.forEach((e, i) => e < errs[bestIdx] && (bestIdx = i));
  const finite = errs.filter(Number.isFinite);
  const lo = Math.min(...finite), hi = Math.max(...finite);
  // Uninformative overlaps (blank walls, inconsistent frames): fall back to a typical phone FOV.
  if (!finite.length || (hi - lo) / Math.max(1, lo) < 0.05) return DEFAULT_FOV;
  // A minimum at the edge of the plausible range means the data didn't constrain the FOV.
  if (bestIdx === 0 || bestIdx === candidates.length - 1) return DEFAULT_FOV;
  let best = candidates[bestIdx], bestErr = errs[bestIdx];
  for (const c of [best - 2, best - 1, best + 1, best + 2]) {
    if (c < FOV_RANGE[0] || c > FOV_RANGE[1]) continue;
    const e = overlapError(small, c, 512);
    if (e < bestErr) [best, bestErr] = [c, e];
  }
  return best;
}

export function stitchEquirect(frames: StitchFrame[], opts: StitchOptions = {}): StitchResult {
  if (frames.length < 2) throw new Error("Need at least 2 frames");
  const W = opts.width ?? 4096;
  const H = W / 2;
  const fov = opts.fovLongDeg ?? estimateFov(frames, opts.fovCandidates);
  const adjustments = frames.map(() => ({ dyawDeg: 0, dpitchDeg: 0, drollDeg: 0, gain: 1 }));
  // Per-frame gain field c0 + c1·x + c2·y + c3·r² over normalised image coordinates.
  let photometric: number[][] = frames.map(() => [1, 0, 0, 0]);
  let disagreement: number | null = null;
  const bases = frames.map((f) => f.basis);

  // --- Global alignment: pairwise measurements + least squares, then a fine per-frame polish ---
  if (opts.refine !== false) {
    const R = opts.searchDeg ?? 8;
    const level = (W: number, long: number) => ({ W, imgs: frames.map((f) => downscale(f.image, Math.max(1, Math.round(Math.max(f.image.width, f.image.height) / long)))) });
    const lo = level(512, 320), hi = level(1024, 640);
    const N = frames.length;
    const solved = solveYaw(frames.map((f) => f.basis), [lo, hi], fov, R);
    const yaw = solved.yaw;
    disagreement = solved.disagreementP90;
    const cur = frames.map((f, k) => adjustBasis(f.basis, yaw[k] * D2R, 0, 0));
    const gains = frames.map(() => 1);
    // Polish: each frame against all the others at higher resolution (small moves, including roll).
    const mHi = newAccum(hi.W, hi.W / 2);
    const add = (img: RawImage, b: Basis, gain: number, sign: 1 | -1) =>
      forEachProjected(mHi.w, mHi.h, img, b, focal(img, fov), (idx, r, g, bl, w) => {
        const ww = w * sign;
        mHi.sum[idx * 3] += r * gain * ww;
        mHi.sum[idx * 3 + 1] += g * gain * ww;
        mHi.sum[idx * 3 + 2] += bl * gain * ww;
        mHi.wsum[idx] += ww;
      });
    for (let k = 0; k < N; k++) add(hi.imgs[k], cur[k], 1, 1);
    for (let k = 0; k < N; k++) {
      add(hi.imgs[k], cur[k], gains[k], -1);
      const fk = focal(hi.imgs[k], fov);
      let best = { b: cur[k], err: Infinity, gain: 1 };
      for (let dy = -0.5; dy <= 0.5 + 1e-9; dy += 0.25)
        for (let dp = -0.5; dp <= 0.5 + 1e-9; dp += 0.25)
          for (const dr of [-0.5, 0, 0.5]) {
            const b = adjustBasis(cur[k], dy * D2R, dp * D2R, dr * D2R);
            const r = matchError(mHi, hi.imgs[k], b, fk);
            if (r.n > 200 && r.err < best.err) best = { b, err: r.err, gain: r.gain };
          }
      if (Number.isFinite(best.err)) {
        cur[k] = best.b;
        gains[k] = Math.min(1.4, Math.max(0.7, best.gain));
      }
      add(hi.imgs[k], cur[k], gains[k], 1);
    }
    // Brightness: fit each frame's smooth gain field (exposure, left/right/top/bottom gradient and lens
    // vignetting) against the blend of the others. Two rounds so frames settle against each other.
    photometric = gains.map((g) => [g, 0, 0, 0]);
    for (let round = 0; round < 2; round++) {
      const m = newAccum(hi.W, hi.W / 2);
      const project = (k: number, sign: 1 | -1) =>
        forEachProjected(m.w, m.h, hi.imgs[k], cur[k], focal(hi.imgs[k], fov), (idx, r, g, bl, w, nx, ny) => {
          const gk = applyGain(photometric[k], nx, ny) * w * sign;
          m.sum[idx * 3] += r * gk;
          m.sum[idx * 3 + 1] += g * gk;
          m.sum[idx * 3 + 2] += bl * gk;
          m.wsum[idx] += w * sign;
        });
      for (let k = 0; k < N; k++) project(k, 1);
      for (let k = 0; k < N; k++) {
        project(k, -1);
        photometric[k] = fitGain(m, hi.imgs[k], cur[k], focal(hi.imgs[k], fov));
        project(k, 1);
      }
    }
    cur.forEach((b, k) => {
      bases[k] = b;
      const w = rotationVectorBetween(frames[k].basis, b);
      const s = frames[k].basis;
      adjustments[k] = { dyawDeg: round2(w[1] / D2R), dpitchDeg: round2(dot3(w, s.right) / D2R), drollDeg: round2(dot3(w, s.forward) / D2R), gain: round2(photometric[k][0]) };
    });
  }

  // --- Two-band blend ---
  // Detail comes from a sharp, centre-weighted blend (the best frame dominates, so parallax ghosts less);
  // smooth brightness comes from a wide blend (hides exposure and lens-vignetting steps between frames).
  // out = lowpass(wide) + (sharp − lowpass(sharp))
  const sharp = newAccum(W, H), wide = newAccum(W, H);
  frames.forEach((fr, k) => {
    const model = photometric[k];
    forEachProjected(W, H, fr.image, bases[k], focal(fr.image, fov), (idx, r, g, b, w, nx, ny) => {
      const gain = applyGain(model, nx, ny);
      const ws = w * w, ww = Math.sqrt(w);
      sharp.sum[idx * 3] += r * gain * ws;
      sharp.sum[idx * 3 + 1] += g * gain * ws;
      sharp.sum[idx * 3 + 2] += b * gain * ws;
      sharp.wsum[idx] += ws;
      wide.sum[idx * 3] += r * gain * ww;
      wide.sum[idx * 3 + 1] += g * gain * ww;
      wide.sum[idx * 3 + 2] += b * gain * ww;
      wide.wsum[idx] += ww;
    });
  });
  const filled = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (sharp.wsum[p] > 1e-7) {
      filled[p] = 1;
      for (let c = 0; c < 3; c++) {
        sharp.sum[p * 3 + c] /= sharp.wsum[p];
        wide.sum[p * 3 + c] /= wide.wsum[p];
      }
    }
  }
  const lowSharp = lowpass(sharp.sum, filled, W, H), lowWide = lowpass(wide.sum, filled, W, H);
  const out = Buffer.alloc(W * H * 3);
  let bandCovered = 0, bandTotal = 0;
  const bandTop = Math.floor(H * (30 / 180)), bandBottom = Math.ceil(H * (150 / 180)); // pitch +60..−60
  for (let j = 0; j < H; j++) {
    const inBand = j >= bandTop && j < bandBottom;
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (inBand) bandTotal++;
      if (!filled[p]) continue;
      if (inBand) bandCovered++;
      for (let c = 0; c < 3; c++) {
        const v = lowWide(i, j, c) + sharp.sum[p * 3 + c] - lowSharp(i, j, c);
        out[p * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  fillHoles(out, filled, W, H);
  return { pano: { data: out, width: W, height: H, channels: 3 }, fovLongDeg: fov, coverage: bandTotal ? bandCovered / bandTotal : 0, adjustments, bases, pairDisagreementP90Deg: disagreement === null ? null : round2(disagreement) };
}

/**
 * Low-pass filter of a partially covered equirect image (only covered pixels count), computed at 1/8
 * resolution and read back with bilinear interpolation. Returns a sampler (i, j, channel) → value.
 */
function lowpass(img: Float32Array, mask: Uint8Array, W: number, H: number, factor = 8) {
  const w = Math.max(1, Math.floor(W / factor)), h = Math.max(1, Math.floor(H / factor));
  const sum = new Float32Array(w * h * 3), cnt = new Float32Array(w * h);
  for (let j = 0; j < H; j++) {
    const sj = Math.min(h - 1, (j / factor) | 0);
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!mask[p]) continue;
      const q = sj * w + Math.min(w - 1, (i / factor) | 0);
      sum[q * 3] += img[p * 3];
      sum[q * 3 + 1] += img[p * 3 + 1];
      sum[q * 3 + 2] += img[p * 3 + 2];
      cnt[q]++;
    }
  }
  // Normalised box blur (radius 3 at 1/8 scale ≈ 2.5° at 4096 wide), twice; wraps horizontally.
  const R = 3;
  const blur = (src: Float32Array, ch: number, horizontal: boolean) => {
    const dst = new Float32Array(src.length);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        for (let c = 0; c < ch; c++) {
          let s = 0;
          for (let d = -R; d <= R; d++) {
            const ii = horizontal ? (((i + d) % w) + w) % w : i;
            const jj = horizontal ? j : Math.min(h - 1, Math.max(0, j + d));
            s += src[(jj * w + ii) * ch + c];
          }
          dst[(j * w + i) * ch + c] = s;
        }
    return dst;
  };
  let S = sum, C = cnt;
  for (let pass = 0; pass < 2; pass++) {
    S = blur(blur(S, 3, true), 3, false);
    C = blur(blur(C, 1, true), 1, false);
  }
  const avg = new Float32Array(w * h * 3);
  for (let q = 0; q < w * h; q++) for (let c = 0; c < 3; c++) avg[q * 3 + c] = C[q] > 1e-6 ? S[q * 3 + c] / C[q] : 0;
  return (i: number, j: number, c: number) => {
    const x = (i + 0.5) / factor - 0.5, y = Math.min(h - 1, Math.max(0, (j + 0.5) / factor - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w, y1 = Math.min(h - 1, y0 + 1);
    return (avg[(y0 * w + xa) * 3 + c] * (1 - fx) + avg[(y0 * w + xb) * 3 + c] * fx) * (1 - fy) + (avg[(y1 * w + xa) * 3 + c] * (1 - fx) + avg[(y1 * w + xb) * 3 + c] * fx) * fy;
  };
}

function applyGain(c: number[], nx: number, ny: number) {
  const g = c[0] + c[1] * nx + c[2] * ny + c[3] * (nx * nx + ny * ny);
  return g < 0.5 ? 0.5 : g > 2 ? 2 : g;
}

/** Least-squares gain field so that frame·gain(x, y) matches the mosaic where they overlap (luma). */
function fitGain(m: Accum, img: RawImage, basis: Basis, f: number): number[] {
  const A = Array.from({ length: 4 }, () => new Float64Array(4));
  const rhs = new Float64Array(4);
  let n = 0;
  forEachProjected(m.w, m.h, img, basis, f, (idx, r, g, b, _w, nx, ny) => {
    const wm = m.wsum[idx];
    if (wm < 0.05) return;
    const fl = 0.299 * r + 0.587 * g + 0.114 * b;
    const ml = (0.299 * m.sum[idx * 3] + 0.587 * m.sum[idx * 3 + 1] + 0.114 * m.sum[idx * 3 + 2]) / wm;
    if (fl < 8 || fl > 250 || ml > 250) return; // ignore clipped pixels
    const x = [fl, fl * nx, fl * ny, fl * (nx * nx + ny * ny)];
    for (let p = 0; p < 4; p++) {
      rhs[p] += x[p] * ml;
      for (let q = 0; q < 4; q++) A[p][q] += x[p] * x[q];
    }
    n++;
  });
  if (n < 200) return [1, 0, 0, 0];
  // Mild ridge towards "no change" keeps under-constrained terms (thin overlaps) from running away.
  const prior = [1, 0, 0, 0];
  const lam = A[0][0] * 0.02;
  for (let p = 0; p < 4; p++) {
    A[p][p] += lam;
    rhs[p] += lam * prior[p];
  }
  const c = Array.from(solveLinear(A, rhs));
  return c.every(Number.isFinite) ? c : [1, 0, 0, 0];
}

/** Fill uncovered pixels: poles take the (smoothed) colour of the nearest covered row; small gaps by dilation. */
function fillHoles(out: Buffer, filled: Uint8Array, W: number, H: number) {
  // Small gaps: a few dilation passes.
  for (let pass = 0; pass < 6; pass++) {
    const next = filled.slice();
    for (let j = 1; j < H - 1; j++)
      for (let i = 0; i < W; i++) {
        const p = j * W + i;
        if (filled[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        const left = j * W + ((i - 1 + W) % W), right = j * W + ((i + 1) % W);
        for (const qq of [left, right, p - W, p + W]) {
          if (filled[qq]) {
            r += out[qq * 3];
            g += out[qq * 3 + 1];
            b += out[qq * 3 + 2];
            n++;
          }
        }
        if (n >= 2) {
          out[p * 3] = r / n;
          out[p * 3 + 1] = g / n;
          out[p * 3 + 2] = b / n;
          next[p] = 1;
        }
      }
    filled.set(next);
  }
  // Poles: per column, extend the nearest covered pixel, then blur horizontally to hide streaks.
  const fillPole = (fromTop: boolean) => {
    const edge = new Float32Array(W * 3);
    const edgeRow = new Int32Array(W).fill(-1);
    for (let i = 0; i < W; i++) {
      for (let s = 0; s < H; s++) {
        const j = fromTop ? s : H - 1 - s;
        if (filled[j * W + i]) {
          edgeRow[i] = j;
          edge.set([out[(j * W + i) * 3], out[(j * W + i) * 3 + 1], out[(j * W + i) * 3 + 2]], i * 3);
          break;
        }
      }
    }
    // Columns without any coverage take the average edge colour.
    let ar = 0, ag = 0, ab = 0, an = 0;
    for (let i = 0; i < W; i++) if (edgeRow[i] >= 0) [ar, ag, ab, an] = [ar + edge[i * 3], ag + edge[i * 3 + 1], ab + edge[i * 3 + 2], an + 1];
    for (let i = 0; i < W; i++) if (edgeRow[i] < 0 && an) edge.set([ar / an, ag / an, ab / an], i * 3);
    const R = Math.max(8, W >> 6);
    const sm = new Float32Array(W * 3);
    for (let i = 0; i < W; i++) {
      let r = 0, g = 0, b = 0;
      for (let d = -R; d <= R; d++) {
        const k = ((i + d) % W + W) % W;
        r += edge[k * 3];
        g += edge[k * 3 + 1];
        b += edge[k * 3 + 2];
      }
      sm.set([r / (2 * R + 1), g / (2 * R + 1), b / (2 * R + 1)], i * 3);
    }
    for (let i = 0; i < W; i++) {
      const stop = edgeRow[i] < 0 ? (fromTop ? H / 2 : H / 2) : edgeRow[i];
      for (let s = 0; s < H; s++) {
        const j = fromTop ? s : H - 1 - s;
        if ((fromTop && j >= stop) || (!fromTop && j <= stop)) break;
        const p = j * W + i;
        if (filled[p]) continue;
        out[p * 3] = sm[i * 3];
        out[p * 3 + 1] = sm[i * 3 + 1];
        out[p * 3 + 2] = sm[i * 3 + 2];
        filled[p] = 1;
      }
    }
  };
  fillPole(true);
  fillPole(false);
  // Any interior gaps left (e.g. between rows when a shot was off-target): grow inwards until closed.
  for (let pass = 0; pass < 400; pass++) {
    let left = 0;
    const next = filled.slice();
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const p = j * W + i;
        if (filled[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const q of [j * W + ((i - 1 + W) % W), j * W + ((i + 1) % W), j > 0 ? p - W : -1, j < H - 1 ? p + W : -1]) {
          if (q >= 0 && filled[q]) {
            r += out[q * 3];
            g += out[q * 3 + 1];
            b += out[q * 3 + 2];
            n++;
          }
        }
        if (n) {
          out[p * 3] = r / n;
          out[p * 3 + 1] = g / n;
          out[p * 3 + 2] = b / n;
          next[p] = 1;
        } else left++;
      }
    filled.set(next);
    if (!left) break;
  }
}
