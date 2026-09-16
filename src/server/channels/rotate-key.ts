import { z } from "zod";
import { readConfig } from "../config.js";
import { Pool, transaction } from "../db/index.js";
import { encrypt, decrypt } from "./crypto.js";
import { audit } from "../audit/index.js";

if (!process.argv.includes("--confirm-key-rotation"))
  throw new Error(
    "Stop app/worker and back up keys before --confirm-key-rotation",
  );
const current = readConfig();
const target = z
  .object({
    NEXT_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
    NEXT_ENCRYPTION_KEY_ID: z.string().min(1).max(50),
  })
  .parse(process.env);
if (
  current.HELPA_MODE !== "dry_run" ||
  target.NEXT_ENCRYPTION_KEY_ID === current.ENCRYPTION_KEY_ID
)
  throw new Error("Rotation requires dry_run and a new key version");
const next = {
  ENCRYPTION_KEY: target.NEXT_ENCRYPTION_KEY,
  ENCRYPTION_KEY_ID: target.NEXT_ENCRYPTION_KEY_ID,
};
const pool = new Pool({ connectionString: current.DATABASE_URL });
try {
  await transaction(pool, async (db) => {
    const channels = await db.query(
      "SELECT id,business_id,credentials_encrypted FROM channel WHERE credentials_encrypted IS NOT NULL FOR UPDATE",
    );
    for (const row of channels.rows) {
      const context = `${row.business_id}:channel:${row.id}`;
      const value = decrypt(row.credentials_encrypted, context, current);
      await db.query(
        "UPDATE channel SET credentials_encrypted=$1 WHERE id=$2 AND business_id=$3",
        [
          JSON.stringify(encrypt(value, context, next)),
          row.id,
          row.business_id,
        ],
      );
    }
    const calls = await db.query("SELECT * FROM llm_call FOR UPDATE");
    for (const row of calls.rows)
      for (const field of ["request", "response"] as const) {
        const value = row[field + "_encrypted"];
        if (value) {
          const context = `${row.business_id}:llm:${row.id}:${field}`;
          await db.query(
            `UPDATE llm_call SET ${field}_encrypted=$1 WHERE id=$2`,
            [encrypt(decrypt(value, context, current), context, next), row.id],
          );
        }
      }
    await db.query("DELETE FROM oauth_selection");
    await db.query("DELETE FROM oauth_state");
    for (const business of (await db.query("SELECT id FROM business")).rows)
      await audit(db, {
        businessId: business.id,
        actorType: "host_operator",
        action: "credentials.key_rotated",
        payload: {
          from: current.ENCRYPTION_KEY_ID,
          to: next.ENCRYPTION_KEY_ID,
        },
      });
  });
  console.log(
    "Credential encryption rotated. Install the matching key/version in .env before restarting. Keep historical keys for backups.",
  );
} finally {
  await pool.end();
}
