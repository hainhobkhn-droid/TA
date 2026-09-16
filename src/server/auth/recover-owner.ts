import { randomUUID } from "node:crypto";
import { readConfig } from "../config.js";
import { Pool, transaction } from "../db/index.js";
import { audit } from "../audit/index.js";

// Offline operator recovery, deliberately not exposed over HTTP.
if (!process.argv.includes("--confirm-owner-mfa-reset"))
  throw new Error(
    "Stop app/worker, preserve a backup, then pass --confirm-owner-mfa-reset",
  );
const c = readConfig();
if (c.HELPA_MODE !== "dry_run")
  throw new Error("Owner recovery requires HELPA_MODE=dry_run");
const pool = new Pool({ connectionString: c.DATABASE_URL });
try {
  await transaction(pool, async (db) => {
    const result = await db.query(
      "SELECT business_id,user_id FROM membership WHERE role='owner' FOR UPDATE",
    );
    if (result.rowCount !== 1) throw new Error("Expected exactly one owner");
    const owner = result.rows[0];
    await audit(db, {
      businessId: owner.business_id,
      actorType: "host_operator",
      action: "auth.owner_mfa_reset",
      payload: { ownerId: owner.user_id, recoveryId: randomUUID() },
    });
    await db.query('DELETE FROM session WHERE "userId"=$1', [owner.user_id]);
    await db.query('DELETE FROM "twoFactor" WHERE "userId"=$1', [
      owner.user_id,
    ]);
    await db.query('UPDATE "user" SET "twoFactorEnabled"=false WHERE id=$1', [
      owner.user_id,
    ]);
  });
  console.log(
    "Owner sessions and MFA enrollment revoked. Password is unchanged; owner must enroll TOTP before business access.",
  );
} finally {
  await pool.end();
}
