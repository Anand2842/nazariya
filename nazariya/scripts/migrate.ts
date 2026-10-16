import { migrateDatabase } from "../src/server/migrate";

const test = process.argv.includes("--test");
const reset = process.argv.includes("--reset");
const url = test ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set (did you pass --env-file=.env.local?)");
if (reset && process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
await migrateDatabase(url, { reset });
console.log(`migrated ${url.replace(/\/\/[^@]*@/, "//***@")}${reset ? " (reset)" : ""}`);
