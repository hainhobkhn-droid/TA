import { channelAdapter } from "./adapter.js";
import { randomUUID } from "node:crypto";
import { transaction, type PgPool } from "../db/index.js";
import type { Config } from "../config.js";
import { decrypt, encrypt } from "./crypto.js";
import { tiktokCall } from "./tiktok.js";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
export async function maintainChannels(
  pool: PgPool,
  c: Config,
  fetcher: typeof fetch = fetch,
) {
  const rows = (
    await pool.query(
      "SELECT * FROM channel WHERE status='connected' AND credentials_encrypted IS NOT NULL AND next_token_check_at<=now() ORDER BY next_token_check_at LIMIT 10",
    )
  ).rows;
  for (const ch of rows) {
    const lock = await pool.connect();
    let held = false;
    try {
      held = (
        await lock.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
          [`token:${ch.id}`],
        )
      ).rows[0].ok;
      if (!held) continue;
      await pool.query(
        "UPDATE channel SET next_token_check_at=now()+interval '1 hour' WHERE id=$1",
        [ch.id],
      );
      const creds: any = decrypt(
        ch.credentials_encrypted,
        `${ch.business_id}:channel:${ch.id}`,
        c,
      );
      const refreshed = await channelAdapter(ch.platform, {
        config: c,
        channel: ch,
        credentials: creds,
        fetcher,
      }).refreshCredentials();
      if (!refreshed) continue;
      const { next, expires, expiryKind, scopes } = refreshed;
      await transaction(pool, async (db) => {
        const changed = await db.query(
          "UPDATE channel SET credentials_encrypted=$2,token_expires_at=$3,token_expiry_kind=$4,granted_scopes=$5,token_checked_at=now(),maintenance_error=NULL WHERE id=$1 AND status='connected' AND credentials_encrypted=$6 RETURNING id",
          [
            ch.id,
            encrypt(next, `${ch.business_id}:channel:${ch.id}`, c),
            expires,
            expiryKind,
            scopes,
            ch.credentials_encrypted,
          ],
        );
        if (!changed.rowCount) return;
        await audit(db, {
          businessId: ch.business_id,
          actorType: "worker",
          channelId: ch.id,
          action:
            next !== creds
              ? "channel.token_refreshed"
              : "channel.token_checked",
          payload: { expiresAt: expires, expiryKind, scopes },
        });
        if (expires && +new Date(expires) < Date.now() + 7 * 86400000)
          await alert(db, ch, "TOKEN_EXPIRES_WITHIN_7_DAYS", String(expires));
      });
    } catch (e) {
      const error =
        e instanceof AppError ? e.code : "TOKEN_REFRESH_OR_CHECK_UNCERTAIN";
      await transaction(pool, async (db) => {
        await db.query(
          "UPDATE channel SET maintenance_error=$2,status=CASE WHEN $3 THEN 'reconnect_required' ELSE status END WHERE id=$1 AND status='connected' AND credentials_encrypted=$4",
          [
            ch.id,
            error,
            error.includes("RECONNECT") || ch.platform === "tiktok",
            ch.credentials_encrypted,
          ],
        );
        await alert(db, ch, error, new Date().toISOString().slice(0, 10));
        await audit(db, {
          businessId: ch.business_id,
          actorType: "worker",
          channelId: ch.id,
          action: "channel.maintenance_failed",
          payload: { error },
        });
      });
    } finally {
      if (held)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          `token:${ch.id}`,
        ]);
      lock.release();
    }
  }
}
async function alert(db: any, ch: any, reason: string, key: string) {
  const owner = (
    await db.query(
      "SELECT user_id FROM membership WHERE business_id=$1 AND role='owner' AND revoked_at IS NULL",
      [ch.business_id],
    )
  ).rows[0];
  for (const transport of ["email", "in_app"])
    await db.query(
      "INSERT INTO notification(id,business_id,user_id,channel_id,kind,transport,subject,body,dedup_key) VALUES($1,$2,$3,$4,'token_health',$5,'Helpa: channel needs attention',$6,$7) ON CONFLICT DO NOTHING",
      [
        randomUUID(),
        ch.business_id,
        owner.user_id,
        ch.id,
        transport,
        `${ch.display_name}: ${reason}`,
        `token:${ch.id}:${reason}:${key}`,
      ],
    );
}
export async function reconcileTikTok(
  pool: PgPool,
  c: Config,
  fetcher: typeof fetch = fetch,
) {
  if (!c.TIKTOK_CLIENT_KEY) return;
  const rows = (
    await pool.query(
      "SELECT v.*,ch.credentials_encrypted FROM post_variant v JOIN channel ch ON ch.id=v.channel_id WHERE ch.platform='tiktok' AND ch.status='connected' AND ch.credentials_encrypted IS NOT NULL AND v.status='needs_action' AND v.platform_id IS NOT NULL AND v.error IN ('TIKTOK_FINISH_IN_APP','TIKTOK_PROCESSING_VERIFY_STATUS') AND v.next_status_check_at<=now() LIMIT 10",
    )
  ).rows;
  for (const v of rows) {
    await pool.query(
      "UPDATE post_variant SET next_status_check_at=now()+interval '1 minute' WHERE id=$1",
      [v.id],
    );
    try {
      const token: any = decrypt(
        v.credentials_encrypted,
        `${v.business_id}:channel:${v.channel_id}`,
        c,
      );
      const r = await tiktokCall(
        "post/publish/status/fetch/",
        token.accessToken,
        { publish_id: v.platform_id },
        fetcher,
      );
      if (!["PUBLISH_COMPLETE", "FAILED"].includes(r.status)) continue;
      await transaction(pool, async (db) => {
        const result = await db.query(
          "UPDATE post_variant SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status='needs_action' RETURNING id",
          [
            v.id,
            r.status === "PUBLISH_COMPLETE" ? "published" : "failed",
            r.status === "PUBLISH_COMPLETE"
              ? "TIKTOK_PUBLISHED_PERMALINK_NOT_PROVIDED"
              : "TIKTOK_PUBLISH_FAILED",
          ],
        );
        if (result.rowCount)
          await audit(db, {
            businessId: v.business_id,
            actorType: "worker",
            channelId: v.channel_id,
            action: "post.status_reconciled",
            payload: {
              variantId: v.id,
              publishId: v.platform_id,
              status: r.status,
              permalink: null,
            },
          });
      });
    } catch {
      /* Back off read-only status checks. Never reinitialize the upload. */
    }
  }
}
