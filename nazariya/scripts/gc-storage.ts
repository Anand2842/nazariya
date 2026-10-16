// Removes files in the local storage folder that no database row references (orphans from deleted
// media, failed jobs or test runs). Only touches files older than one hour. Dry run unless --delete.
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../src/server/db";
import { storageRoot } from "../src/server/storage";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function main() {
  const root = storageRoot();
  const rows = (await db.execute(sql`
    select storage_key as k from media_assets
    union select value from media_assets, jsonb_each_text(variants)
    union select f->>'key' from media_assets, jsonb_array_elements(coalesce(meta->'capture'->'frames','[]'::jsonb)) f`)) as unknown as { k: string }[];
  const keep = new Set(rows.map((r) => r.k).filter(Boolean));
  const cutoff = Date.now() - 3600_000;
  let orphans = 0, bytes = 0;
  for await (const file of walk(root)) {
    const key = path.relative(root, file).split(path.sep).join("/");
    if (keep.has(key)) continue;
    const st = await stat(file);
    if (st.mtimeMs > cutoff) continue;
    orphans++;
    bytes += st.size;
    if (process.argv.includes("--delete")) await rm(file);
  }
  console.log(`${orphans} orphan file(s), ${(bytes / 1048576).toFixed(1)} MB${process.argv.includes("--delete") ? " deleted" : " (dry run; pass --delete)"}`);
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
