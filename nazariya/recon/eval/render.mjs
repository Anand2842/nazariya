// Render a splat from COLMAP camera poses and put each render next to the real frame, with PSNR.
// Usage: node render.mjs <scene.ply> <colmap_txt_dir> <images_dir> <out.jpg>
import { createReadStream, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const sharp = require("sharp");

const [ply, txt, imagesDir, out] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // three.js and Spark come straight from the app's node_modules (nothing copied next to this script).
  const mods = { "/three.module.js": "three/build/three.module.js", "/three.core.js": "three/build/three.core.js", "/spark.module.js": "@sparkjsdev/spark/dist/spark.module.js" };
  const file = u.pathname === "/scene.ply" ? ply : mods[u.pathname] ? path.join(here, "../../node_modules", mods[u.pathname]) : path.join(here, u.pathname === "/" ? "index.html" : u.pathname);
  try {
    statSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(8765, "127.0.0.1");

const cam = readFileSync(path.join(txt, "cameras.txt"), "utf8").split("\n").find((l) => l && !l.startsWith("#")).split(" ");
const [W, H, fx, fy, cx, cy] = [Number(cam[2]), Number(cam[3]), Number(cam[4]), Number(cam[5]), Number(cam[6]), Number(cam[7])];
const lines = readFileSync(path.join(txt, "images.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
const imgs = [];
for (let i = 0; i < lines.length; i += 2) {
  const p = lines[i].split(" ");
  if (p.length < 10) continue;
  const [qw, qx, qy, qz, tx, ty, tz] = p.slice(1, 8).map(Number);
  const R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), 2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), 2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)];
  imgs.push({ name: p[p.length - 1], R, t: [tx, ty, tz] });
}
imgs.sort((a, b) => a.name.localeCompare(b.name));
const novel = process.env.NOVEL_POSES ? JSON.parse(readFileSync(process.env.NOVEL_POSES, "utf8")) : null;
// EVAL_LIST: score these images (held out of training); the sheet shows the first SHEET of them.
const evalNames = process.env.EVAL_LIST ? new Set(readFileSync(process.env.EVAL_LIST, "utf8").split("\n").filter(Boolean)) : null;
const picks = novel ?? (evalNames ? imgs.filter((im) => evalNames.has(im.name)) : Array.from({ length: 6 }, (_, k) => imgs[Math.floor(((k + 0.5) * imgs.length) / 6)]));
const sheetN = Number(process.env.SHEET ?? picks.length);

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("page error", e.message));
await page.goto(`http://127.0.0.1:8765/?ply=/scene.ply`);
await page.waitForFunction(() => window.ready === true, null, { timeout: 300_000 });
const scale = 360 / W, w = 360, h = Math.round(H * scale);
const tiles = [];
const psnrs = [];
for (const im of picks) {
  const data = await page.evaluate(([R, t, fx, fy, cx, cy, w, h]) => window.renderView(R, t, fx, fy, cx, cy, w, h), [im.R, im.t, fx * scale, fy * scale, cx * scale, cy * scale, w, h]);
  const render = await sharp(Buffer.from(data.split(",")[1], "base64")).resize(w, h).removeAlpha().raw().toBuffer();
  const photo = novel ? Buffer.alloc(render.length, 40) : await sharp(path.join(imagesDir, im.name)).resize(w, h).removeAlpha().raw().toBuffer();
  let se = 0;
  for (let i = 0; i < render.length; i++) se += (render[i] - photo[i]) ** 2;
  const psnr = 10 * Math.log10((255 * 255) / (se / render.length));
  psnrs.push(psnr);
  const label = Buffer.from(`<svg width="${w * 2}" height="28"><rect width="100%" height="100%" fill="black"/><text x="8" y="20" font-size="16" fill="white" font-family="sans-serif">${novel ? `${im.name} (new viewpoint)` : `${im.name}: real photo | 3D render · PSNR ${psnr.toFixed(1)} dB`}</text></svg>`);
  if (tiles.length < sheetN) tiles.push(await sharp({ create: { width: w * 2, height: h + 28, channels: 3, background: "#000" } }).composite([{ input: label, top: 0, left: 0 }, { input: await sharp(photo, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), top: 28, left: 0 }, { input: await sharp(render, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), top: 28, left: w }]).png().toBuffer());
}
const sorted = [...psnrs].sort((a, b) => a - b);
console.log(evalNames ? `views ${psnrs.length}  PSNR mean ${(psnrs.reduce((a, b) => a + b, 0) / psnrs.length).toFixed(2)}  median ${sorted[sorted.length >> 1].toFixed(2)}  worst 10% ${sorted[Math.floor(sorted.length * 0.1)].toFixed(2)}` : `PSNR per view: ${psnrs.map((p) => p.toFixed(1)).join(", ")} mean ${(psnrs.reduce((a, b) => a + b, 0) / psnrs.length).toFixed(1)}`);
if (process.env.PSNR_OUT) (await import("node:fs")).writeFileSync(process.env.PSNR_OUT, JSON.stringify(Object.fromEntries(picks.map((im, i) => [im.name, psnrs[i]]))));
if (tiles.length) {
const cols = 3, tw = w * 2, th = h + 28;
await sharp({ create: { width: tw * cols, height: th * Math.ceil(tiles.length / cols), channels: 3, background: "#000" } })
  .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
  .jpeg({ quality: 80 })
  .toFile(out);
}
await browser.close();
server.close();
