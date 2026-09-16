import { randomUUID } from "node:crypto";
import type { PoolClient, PgPool } from "../db/index.js";
export async function audit(
  db: Pick<PoolClient | PgPool, "query">,
  event: {
    businessId: string;
    actorId?: string;
    actorType?: string;
    action: string;
    channelId?: string;
    payload?: unknown;
  },
) {
  await db.query(
    "INSERT INTO audit_event(id,business_id,actor_id,actor_type,action,channel_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      randomUUID(),
      event.businessId,
      event.actorId ?? null,
      event.actorType ?? "user",
      event.action,
      event.channelId ?? null,
      JSON.stringify(event.payload ?? {}),
    ],
  );
}
