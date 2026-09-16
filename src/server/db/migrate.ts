import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PgPool } from "./index.js";
import { readConfig } from "../config.js";

export async function migrate(pool: PgPool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(781209)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(resolve("migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(resolve("migrations", name), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM schema_migration WHERE name=$1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== hash)
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migration(name,checksum) VALUES($1,$2)",
          [name, hash],
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(781209)");
    client.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const pool = new Pool({ connectionString: readConfig().DATABASE_URL });
  try {
    await migrate(pool);
    console.log("Migrations applied");
  } finally {
    await pool.end();
  }
}
