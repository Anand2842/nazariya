// Object storage abstraction. Local filesystem driver for development;
// production swaps in an S3/R2 driver with the same interface (content-addressed, immutable keys).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function storageRoot(): string {
  return path.resolve(process.env.STORAGE_DIR ?? "./storage");
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]*$/i;

export function assertSafeKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key");
}

export function absPath(key: string): string {
  assertSafeKey(key);
  const p = path.resolve(storageRoot(), key);
  if (!p.startsWith(storageRoot() + path.sep)) throw new Error("Invalid storage key");
  return p;
}

export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Visibility: public objects are served by /media; private ones (documents, raw uploads) are not. */
export function isPublicKey(key: string): boolean {
  return key.startsWith("pub/");
}

export async function putBuffer(key: string, data: Uint8Array): Promise<void> {
  const p = absPath(key);
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}

export async function putFile(key: string, srcPath: string): Promise<void> {
  const p = absPath(key);
  await mkdir(path.dirname(p), { recursive: true });
  await copyFile(srcPath, p);
}

export async function getBuffer(key: string): Promise<Buffer> {
  return readFile(absPath(key));
}

export async function exists(key: string): Promise<boolean> {
  try {
    await stat(absPath(key));
    return true;
  } catch {
    return false;
  }
}

export function openStream(key: string) {
  return createReadStream(absPath(key));
}

export async function sizeOf(key: string): Promise<number> {
  return (await stat(absPath(key))).size;
}

export function publicUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (!isPublicKey(key)) throw new Error("Refusing to expose a private object");
  return `/media/${key}`;
}

/** Content-addressed key: pub/<kind>/<aa>/<sha>.<ext> */
export function contentKey(visibility: "pub" | "priv", kind: string, hash: string, ext: string): string {
  return `${visibility}/${kind}/${hash.slice(0, 2)}/${hash}.${ext}`;
}
