import { randomUUID, createHash } from "node:crypto";
import { transaction, type PgPool, type PoolClient } from "../db/index.js";
import { audit } from "../audit/index.js";
import type { Actor } from "../auth/index.js";
import { AppError } from "../errors.js";
import { mapRows, recordKey, type Dataset } from "./schema.js";
export async function syncRows(
  pool: PgPool,
  actor: Actor,
  sourceId: string,
  raw: Record<string, unknown>[],
  mapping?: Record<string, string>,
  client?: PoolClient,
) {
  const reader = client ?? pool;
  const source = (
    await reader.query(
      "SELECT * FROM knowledge_source WHERE business_id=$1 AND id=$2",
      [actor.businessId, sourceId],
    )
  ).rows[0];
  if (!source) throw new AppError(404, "SOURCE_NOT_FOUND");
  if (raw.length > 10000) throw new AppError(400, "TOO_MANY_ROWS");
  const converted = mapRows(
    source.dataset,
    structuredClone(raw),
    mapping ?? source.mapping,
  );
  const future = converted.rows.some((r) =>
    [r.updated_at, r.price_updated_at, r.stock_updated_at]
      .filter(Boolean)
      .some((t) => new Date(t).getTime() > Date.now() + 60000),
  );
  if (future)
    converted.errors.push({
      row: 0,
      fields: ["updated_at"],
      message: "Source timestamps cannot be in the future",
    });
  if (converted.errors.length) {
    await reader.query(
      "INSERT INTO knowledge_sync(id,business_id,source_id,status,row_count,error) VALUES($1,$2,$3,'rejected',$4,$5)",
      [
        randomUUID(),
        actor.businessId,
        sourceId,
        raw.length,
        JSON.stringify(converted.errors),
      ],
    );
    return { ok: false as const, errors: converted.errors, rows: 0 };
  }
  const work = async (db: PoolClient) => {
    await db.query("SELECT id FROM knowledge_source WHERE id=$1 FOR UPDATE", [
      sourceId,
    ]);
    let changed = 0;
    const activeKeys: string[] = [];
    for (let i = 0; i < converted.rows.length; i++) {
      const data = converted.rows[i];
      const key = recordKey(source.dataset as Dataset, data);
      activeKeys.push(key);
      const old = (
        await db.query(
          "SELECT v.* FROM knowledge_version v WHERE v.source_id=$1 AND v.record_key=$2 ORDER BY v.version DESC LIMIT 1",
          [sourceId, key],
        )
      ).rows[0];
      const timestamps = Object.fromEntries(
        Object.keys(data).map((field) => [
          field,
          ["price", "currency", "unit"].includes(field)
            ? (data.price_updated_at ?? data.updated_at)
            : ["stock_status", "stock_qty"].includes(field)
              ? (data.stock_updated_at ?? data.updated_at)
              : data.updated_at,
        ]),
      );
      const hash = createHash("sha256")
        .update(JSON.stringify({ data, timestamps }))
        .digest("hex");
      if (old?.content_hash === hash) {
        await db.query(
          "INSERT INTO knowledge_current(business_id,source_id,record_key,version_id) VALUES($1,$2,$3,$4) ON CONFLICT(business_id,source_id,record_key) DO UPDATE SET version_id=excluded.version_id",
          [actor.businessId, sourceId, key, old.id],
        );
        continue;
      }
      const id = randomUUID();
      await db.query(
        "INSERT INTO knowledge_version(id,business_id,source_id,record_key,version,source_row,data,field_timestamps,content_hash,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          actor.businessId,
          sourceId,
          key,
          (old?.version ?? 0) + 1,
          i + 2,
          data,
          timestamps,
          hash,
          actor.userId,
        ],
      );
      await db.query(
        "INSERT INTO knowledge_current(business_id,source_id,record_key,version_id) VALUES($1,$2,$3,$4) ON CONFLICT(business_id,source_id,record_key) DO UPDATE SET version_id=excluded.version_id",
        [actor.businessId, sourceId, key, id],
      );
      changed++;
    }
    await db.query(
      "DELETE FROM knowledge_current WHERE source_id=$1 AND NOT(record_key=ANY($2::text[]))",
      [sourceId, activeKeys],
    );
    await db.query(
      "UPDATE knowledge_source SET mapping=$2,last_sync_at=now(),next_sync_at=now()+interval '10 minutes',status='ready' WHERE id=$1",
      [sourceId, mapping ?? source.mapping],
    );
    await db.query(
      "INSERT INTO knowledge_sync(id,business_id,source_id,status,row_count,changed_count) VALUES($1,$2,$3,'succeeded',$4,$5)",
      [randomUUID(), actor.businessId, sourceId, raw.length, changed],
    );
    await audit(db, {
      businessId: actor.businessId,
      actorId: actor.userId,
      action: "knowledge.synced",
      payload: {
        sourceId,
        rowCount: raw.length,
        changed,
        sourceTimestampsPreserved: true,
      },
    });
    return { ok: true as const, rows: raw.length, changed };
  };
  return client ? work(client) : transaction(pool, work);
}
export async function currentKnowledge(pool: PgPool, businessId: string) {
  return (
    await pool.query(
      "SELECT v.*,s.dataset,s.name AS source_name,s.max_age_hours FROM knowledge_current c JOIN knowledge_version v ON v.id=c.version_id JOIN knowledge_source s ON s.id=v.source_id WHERE c.business_id=$1",
      [businessId],
    )
  ).rows;
}
