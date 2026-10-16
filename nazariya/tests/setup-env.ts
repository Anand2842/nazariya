// Runs in each test worker before test files are imported.
import { tmpdir } from "node:os";
import path from "node:path";
try {
  process.loadEnvFile(".env.local");
} catch {}
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://nazariya@localhost:54329/nazariya_test";
process.env.DEV_TOOLS = "1";
// Always isolate test files from the dev storage folder (global-setup wipes this directory per run).
process.env.STORAGE_DIR = path.join(tmpdir(), "nazariya-test-storage");
