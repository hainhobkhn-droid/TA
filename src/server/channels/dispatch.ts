import { randomUUID } from "node:crypto";
import { transaction, type PgPool } from "../db/index.js";
import { audit } from "../audit/index.js";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

export function effectiveMode(
  global: "dry_run" | "live",
  channel: "dry_run" | "live" | "manual",
) {
  return global === "dry_run" ? "dry_run" : channel;
}
// Diagnostic only. Publisher and reply dispatchers enforce the same dry-run boundary.
export async function recordDryRun(
  pool: PgPool,
  c: Config,
  input: {
    businessId: string;
    actorId: string;
    operationKey: string;
    payload: unknown;
  },
) {
  if (c.HELPA_MODE !== "dry_run") throw new AppError(409, "DRY_RUN_REQUIRED");
  return transaction(pool, async (db) => {
    const actor = await db.query(
      "SELECT role FROM membership WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE",
      [input.businessId, input.actorId],
    );
    if (!actor.rowCount || actor.rows[0].role !== "owner")
      throw new AppError(403, "FORBIDDEN");
    const id = randomUUID();
    const inserted = await db.query(
      "INSERT INTO outbound_operation(id,business_id,operation_key,payload,mode,outcome) VALUES($1,$2,$3,$4,'dry_run','would_have_sent') ON CONFLICT(business_id,operation_key) DO NOTHING RETURNING id",
      [id, input.businessId, input.operationKey, JSON.stringify(input.payload)],
    );
    if (!inserted.rowCount) return { duplicate: true };
    await audit(db, {
      businessId: input.businessId,
      actorId: input.actorId,
      actorType: "worker",
      action: "outbound.would_have_sent",
      payload: {
        operationId: id,
        operationKey: input.operationKey,
        exactPayload: input.payload,
      },
    });
    return { id, outcome: "would_have_sent" };
  });
}
