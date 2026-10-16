import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Exec = DB | Tx;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://nazariya@localhost:54329/nazariya";
}

const g = globalThis as unknown as { __nzSql?: postgres.Sql; __nzDb?: DB; __nzUrl?: string };

function init() {
  const url = databaseUrl();
  if (!g.__nzSql || g.__nzUrl !== url) {
    g.__nzSql = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10), onnotice: () => {}, idle_timeout: 30 });
    g.__nzDb = drizzle(g.__nzSql, { schema });
    g.__nzUrl = url;
  }
  return { sqlClient: g.__nzSql, db: g.__nzDb! };
}

export function getDb(): DB {
  return init().db;
}

export function getSql(): postgres.Sql {
  return init().sqlClient;
}

/** Lazily-initialised drizzle instance (so tests can set DATABASE_URL before first use). */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export async function closeDb() {
  if (g.__nzSql) await g.__nzSql.end({ timeout: 5 });
  g.__nzSql = undefined;
  g.__nzDb = undefined;
  g.__nzUrl = undefined;
}
