// Apply supabase/schema.sql and supabase/seed.sql using DATABASE_URL from src/.env.
// Usage (from src/): node scripts/apply-sql.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// minimal .env loader (no quotes expected)
for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is empty in src/.env (Supabase -> Connect -> URI, use the pooler/session string).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
for (const f of ["schema.sql", "seed.sql"]) {
  const sql = readFileSync(join(root, "supabase", f), "utf8");
  await client.query(sql);
  console.log("applied", f);
}
const { rows } = await client.query("select name, monthly_spend, terms_verified from vendors order by monthly_spend desc");
console.table(rows);
await client.end();
