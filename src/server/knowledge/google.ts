import { GoogleAuth } from "google-auth-library";
import type { Config } from "../config.js";
import type { PgPool } from "../db/index.js";
import { AppError } from "../errors.js";
import { googleCsv } from "./import.js";
import { syncRows } from "./service.js";
import type { Actor } from "../auth/index.js";
export async function googleSheet(
  c: Config,
  spreadsheetId: string,
  range: string,
) {
  if (!c.GOOGLE_SERVICE_ACCOUNT_FILE)
    throw new AppError(409, "GOOGLE_SERVICE_ACCOUNT_REQUIRED");
  if (!/^[\w-]+$/.test(spreadsheetId) || !range || range.length > 100)
    throw new AppError(400, "INVALID_SHEET_RANGE");
  const auth = new GoogleAuth({
    keyFile: c.GOOGLE_SERVICE_ACCOUNT_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient();
  const result = await client.request<{ values?: unknown[][] }>({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    params: {
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    },
    timeout: 15000,
    retry: false,
    maxContentLength: 5000000,
  });
  const values = result.data.values ?? [];
  if (values.length > 10001) throw new AppError(400, "TOO_MANY_ROWS");
  const headers = values[0]?.map(String) ?? [];
  if (
    headers.length > 100 ||
    headers.some((h) => !h.trim()) ||
    new Set(headers).size !== headers.length
  )
    throw new AppError(400, "INVALID_COLUMNS");
  return values
    .slice(1)
    .map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
}
export const fetchSource = (c: Config, s: any) =>
  s.kind === "google_api"
    ? googleSheet(c, s.config.spreadsheetId, s.config.range)
    : googleCsv(s.config.url);
export async function pollSources(pool: PgPool, c: Config) {
  const sources = await pool.query(
    "SELECT * FROM knowledge_source WHERE kind IN ('google_csv','google_api') AND next_sync_at<=now() ORDER BY next_sync_at LIMIT 5",
  );
  for (const s of sources.rows) {
    const lock = await pool.connect();
    let held = false;
    try {
      held = (
        await lock.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
          [`source:${s.id}`],
        )
      ).rows[0].ok;
      if (!held) continue;
      await pool.query(
        "UPDATE knowledge_source SET next_sync_at=now()+($2*interval '1 minute') WHERE id=$1",
        [s.id, c.KNOWLEDGE_POLL_MINUTES],
      );
      const owner = (
        await pool.query(
          "SELECT user_id FROM membership WHERE business_id=$1 AND role='owner' AND revoked_at IS NULL",
          [s.business_id],
        )
      ).rows[0];
      await syncRows(
        pool,
        { businessId: s.business_id, userId: owner.user_id } as Actor,
        s.id,
        await fetchSource(c, s),
      );
      await pool.query(
        "UPDATE knowledge_source SET next_sync_at=now()+($2*interval '1 minute') WHERE id=$1",
        [s.id, c.KNOWLEDGE_POLL_MINUTES],
      );
    } catch {
      await pool.query(
        "UPDATE knowledge_source SET status='failed' WHERE id=$1",
        [s.id],
      );
      await pool.query(
        "INSERT INTO knowledge_sync(id,business_id,source_id,status,error) VALUES(gen_random_uuid(),$1,$2,'failed','\"SOURCE_FETCH_OR_SCHEMA_FAILED\"'::jsonb)",
        [s.business_id, s.id],
      );
    } finally {
      if (held)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          `source:${s.id}`,
        ]);
      lock.release();
    }
  }
}
