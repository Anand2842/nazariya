// Image utilities used by the processing pipeline (sharp + plain typed arrays).
import sharp from "sharp";
import { dirFromYawPitch, yawPitchFromDir, type Vec3 } from "@/lib/pano-geometry";

/** 64-bit difference hash (hex) for near-duplicate photo detection. */
export async function dhash(input: Buffer): Promise<string> {
  const { data } = await sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let hex = "";
  for (let row = 0; row < 8; row++) {
    let nibbleBits = 0;
    let bits = 0;
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      nibbleBits = (nibbleBits << 1) | (left > right ? 1 : 0);
      bits++;
      if (bits === 4) {
        hex += nibbleBits.toString(16);
        nibbleBits = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

/** Variance of the Laplacian on a 512px greyscale copy: low values mean blur. */
export async function blurScore(input: Buffer): Promise<number> {
  const { data, info } = await sharp(input).grayscale().resize(512, 512, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return Math.round((sumSq / n - mean * mean) * 10) / 10;
}

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

export async function loadRaw(input: Buffer | string, maxWidth?: number): Promise<RawImage> {
  let img = sharp(input).removeAlpha();
  if (maxWidth) img = img.resize({ width: maxWidth, withoutEnlargement: true });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Bilinear sample of an equirectangular image at (u,v) in [0,1); returns RGB 0..255. */
export function sampleEquirect(img: RawImage, u: number, v: number, out: number[] = [0, 0, 0]): number[] {
  const { width: W, height: H, channels: C, data } = img;
  const x = (((u % 1) + 1) % 1) * W - 0.5;
  const y = Math.min(H - 1, Math.max(0, v * H - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = ((x0 % W) + W) % W;
  const xb = (xa + 1) % W;
  const ya = y0;
  const yb = Math.min(H - 1, y0 + 1);
  for (let c = 0; c < 3; c++) {
    const p00 = data[(ya * W + xa) * C + c];
    const p10 = data[(ya * W + xb) * C + c];
    const p01 = data[(yb * W + xa) * C + c];
    const p11 = data[(yb * W + xb) * C + c];
    out[c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
  }
  return out;
}

/** Render a rectilinear (normal camera) view from an equirectangular panorama. */
export async function equirectToPerspective(
  pano: RawImage,
  opts: { yaw: number; pitch?: number; hfovDeg?: number; width: number; height: number },
): Promise<Buffer> {
  const { width, height } = opts;
  const pitch = opts.pitch ?? 0;
  const f = width / 2 / Math.tan(((opts.hfovDeg ?? 75) * Math.PI) / 360);
  const fwd = dirFromYawPitch(opts.yaw, pitch);
  const right: Vec3 = [Math.cos(opts.yaw), 0, Math.sin(opts.yaw)];
  const up: Vec3 = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const out = Buffer.alloc(width * height * 3);
  const px = [0, 0, 0];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = i + 0.5 - width / 2;
      const y = height / 2 - (j + 0.5);
      const d: Vec3 = [fwd[0] * f + right[0] * x + up[0] * y, fwd[1] * f + right[1] * x + up[1] * y, fwd[2] * f + right[2] * x + up[2] * y];
      const { yaw, pitch: p } = yawPitchFromDir(d);
      sampleEquirect(pano, yaw / (2 * Math.PI) + 0.5, 0.5 - p / Math.PI, px);
      const o = (j * width + i) * 3;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
}

/** Render a pinhole camera view (long side = fovLongDeg) from an equirect panorama for an arbitrary camera basis. */
export function renderPerspectiveBasis(
  pano: RawImage,
  basis: { forward: Vec3; right: Vec3; up: Vec3 },
  fovLongDeg: number,
  width: number,
  height: number,
): RawImage {
  const f = Math.max(width, height) / 2 / Math.tan((fovLongDeg * Math.PI) / 360);
  const out = Buffer.alloc(width * height * 3);
  const px = [0, 0, 0];
  const { forward: F, right: R, up: U } = basis;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = i + 0.5 - width / 2;
      const y = height / 2 - (j + 0.5);
      const d: Vec3 = [F[0] * f + R[0] * x + U[0] * y, F[1] * f + R[1] * x + U[1] * y, F[2] * f + R[2] * x + U[2] * y];
      const { yaw, pitch } = yawPitchFromDir(d);
      sampleEquirect(pano, yaw / (2 * Math.PI) + 0.5, 0.5 - pitch / Math.PI, px);
      const o = (j * width + i) * 3;
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
    }
  }
  return { data: out, width, height, channels: 3 };
}
