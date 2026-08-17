/**
 * Migration runner. Applies db/schema.sql against DATABASE_URL.
 *
 *   npm run migrate
 *
 * schema.sql is written to be idempotent (every CREATE is guarded), so this is
 * safe to run repeatedly and on a fresh Postgres alike. Acceptance for build
 * task 0.2: builds every table/enum on a clean database.
 */
import "../lib/loadenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. See .env.example.");
    process.exit(1);
  }

  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const client = new Client({ connectionString: url });

  await client.connect();
  console.log("Connected. Applying schema.sql…");
  try {
    await client.query(sql);
    console.log("✓ Schema applied. Tables and enums are up to date.");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
