import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";

/** Apply all migrations in ./drizzle. With reset=true the public schema is dropped first (dev/test only). */
export async function migrateDatabase(url: string, opts: { reset?: boolean } = {}) {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    if (opts.reset) {
      await client.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
    }
    await migrate(drizzle(client), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  } finally {
    await client.end({ timeout: 5 });
  }
}
