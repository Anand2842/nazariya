// Resets the TEST database once per run (never the dev database).
export default async function setup() {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
  const url = process.env.DATABASE_URL_TEST ?? "postgres://nazariya@localhost:54329/nazariya_test";
  if (!/_test\b/.test(url)) throw new Error(`Refusing to reset non-test database: ${url}`);
  const { rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  await rm(path.join(tmpdir(), "nazariya-test-storage"), { recursive: true, force: true });
  const { migrateDatabase } = await import("../src/server/migrate");
  await migrateDatabase(url, { reset: true });
}
