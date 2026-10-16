// Downloads CC0 indoor 360° panoramas (Poly Haven, tonemapped JPG) used ONLY as demo room captures.
// Production listings use real captures made by listers; these files are never presented as real Delhi homes
// without the "demo content" notice shown in the UI.
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const DEMO_PANOS = [
  "hotel_room",
  "lythwood_room",
  "small_empty_room_1",
  "small_empty_room_3",
  "pine_attic",
  "kiara_interior",
  "bathroom",
  "modern_bathroom",
  "lebombo",
  "cayley_interior",
  "reading_room",
  "comfy_cafe",
  "veranda",
  "photo_studio_loft_hall",
  "brown_photostudio_04",
  "photo_studio_london_hall",
  "brown_photostudio_07",
] as const;

const UA = "nazariya-local-demo/0.1";
const outDir = path.resolve("assets/source");

async function get(url: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
      if (res.ok) return res;
      last = new Error(`${url}: HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw last;
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const credits: string[] = ["# Demo panorama credits", "", "All panoramas: Poly Haven (https://polyhaven.com), licensed CC0. Used as demo content only.", ""];
  for (const id of DEMO_PANOS) {
    const dest = path.join(outDir, `${id}.jpg`);
    const info = (await (await get(`https://api.polyhaven.com/info/${id}`)).json()) as { name: string; authors: Record<string, string> };
    credits.push(`- ${info.name} (${id}): ${Object.keys(info.authors ?? {}).join(", ")} — https://polyhaven.com/a/${id}`);
    if (await exists(dest)) {
      console.log(`✓ ${id} (cached)`);
      continue;
    }
    const files = (await (await get(`https://api.polyhaven.com/files/${id}`)).json()) as { tonemapped?: { url: string } };
    if (!files.tonemapped?.url) throw new Error(`No tonemapped JPG for ${id}`);
    const res = await get(files.tonemapped.url);
    const buf = Buffer.from(await res.arrayBuffer());
    await sharp(buf).resize(4096, 2048, { fit: "fill" }).jpeg({ quality: 85, mozjpeg: true }).toFile(dest);
    console.log(`↓ ${id} (${Math.round(buf.byteLength / 1024)} KB)`);
  }
  await writeFile(path.resolve("assets/CREDITS.md"), credits.join("\n") + "\n");
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
