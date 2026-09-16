import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { transaction, type PgPool } from "../db/index.js";
import type { Config } from "../config.js";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
import { can } from "../../shared/permissions.js";
import {
  validatePublish,
  type PublishPayload,
} from "../../shared/publishing.js";
import { effectiveMode } from "../channels/dispatch.js";
import { decrypt } from "../channels/crypto.js";
import {
  type Step,
  type PublishingTransport,
} from "../channels/facebook-publisher.js";
import { channelAdapter } from "../channels/adapter.js";
import { mediaPath } from "../media/service.js";
export async function dispatchVariant(
  pool: PgPool,
  c: Config,
  id: string,
  now = new Date(),
  factory?: (step: Step) => PublishingTransport,
) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [`publish:${id}`],
      )
    ).rows[0].locked;
    if (!locked) return;
    const v = (
      await pool.query(
        `SELECT v.*,r.payload,c.platform,c.external_id,c.mode,c.status AS channel_status,c.credentials_encrypted,c.granted_scopes,c.token_expires_at FROM post_variant v JOIN post_revision r ON r.variant_id=v.id AND r.revision=v.revision JOIN channel c ON c.id=v.channel_id WHERE v.id=$1`,
        [id],
      )
    ).rows[0];
    if (
      !v ||
      !["scheduled", "publishing"].includes(v.status) ||
      !v.scheduled_at ||
      +new Date(v.scheduled_at) > +now
    )
      return;
    async function authorized() {
      const b = (
        await pool.query("SELECT * FROM business WHERE id=$1", [v.business_id])
      ).rows[0];
      if (b.publishing_paused) throw new AppError(409, "PUBLISHING_PAUSED");
      const latest = (
        await pool.query(
          "SELECT revision,status FROM post_variant WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (
        latest.revision !== v.revision ||
        !["scheduled", "publishing"].includes(latest.status)
      )
        throw new AppError(409, "REVISION_CONFLICT");
      const m = (
        await pool.query(
          "SELECT * FROM membership WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL",
          [v.business_id, v.scheduled_by],
        )
      ).rows[0];
      if (
        !m ||
        !can(
          m.role,
          m.channel_scope,
          "posts.write",
          v.platform,
          m.denied_permissions,
        )
      )
        throw new AppError(403, "SCHEDULER_AUTHORITY_REVOKED");
      if (b.posts_require_approval) {
        const a = (
          await pool.query(
            "SELECT * FROM membership WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL",
            [v.business_id, v.approved_by],
          )
        ).rows[0];
        if (
          v.approved_revision !== v.revision ||
          !a ||
          !["owner", "manager"].includes(a.role) ||
          !can(
            a.role,
            a.channel_scope,
            "approvals.write",
            v.platform,
            a.denied_permissions,
          )
        )
          throw new AppError(409, "APPROVAL_REQUIRED");
      }
      const ch = (
        await pool.query(
          "SELECT mode,status,credentials_encrypted,token_expires_at FROM channel WHERE id=$1",
          [v.channel_id],
        )
      ).rows[0];
      if (
        effectiveMode(c.HELPA_MODE, ch.mode) !==
        effectiveMode(c.HELPA_MODE, v.mode)
      )
        throw new AppError(409, "CHANNEL_MODE_CHANGED");
      if (
        c.HELPA_MODE === "live" &&
        v.mode === "live" &&
        (ch.status !== "connected" ||
          !ch.credentials_encrypted ||
          (ch.token_expires_at &&
            +new Date(ch.token_expires_at) <= +new Date()))
      )
        throw new AppError(409, "CHANNEL_RECONNECT_REQUIRED");
    }
    try {
      await authorized();
    } catch (e) {
      if (
        ["PUBLISHING_PAUSED", "APPROVAL_REQUIRED"].includes(
          (e as AppError).code,
        )
      )
        return;
      await terminal(
        "needs_action",
        (e as AppError).code ?? "AUTHORITY_CHANGED",
      );
      return;
    }
    const p = v.payload as PublishPayload;
    const errors = validatePublish(p);
    if (errors.length) {
      await terminal("failed", errors[0]);
      return;
    }
    const claimed = await pool.query(
      "UPDATE post_variant SET status='publishing',updated_at=now() WHERE id=$1 AND revision=$2 AND status IN ('scheduled','publishing') RETURNING id",
      [id, v.revision],
    );
    if (!claimed.rowCount) return;
    const mode = effectiveMode(c.HELPA_MODE, v.mode);
    const key = `post:${id}:r${v.revision}`;
    if (mode === "dry_run") {
      await transaction(pool, async (db) => {
        await db.query(
          "INSERT INTO outbound_operation(id,business_id,channel_id,operation_key,payload,mode,outcome) VALUES($1,$2,$3,$4,$5,'dry_run','would_have_sent') ON CONFLICT(business_id,operation_key) DO NOTHING",
          [randomUUID(), v.business_id, v.channel_id, key, p],
        );
        await audit(db, {
          businessId: v.business_id,
          actorId: v.scheduled_by,
          actorType: "worker",
          channelId: v.channel_id,
          action: "post.would_have_sent",
          payload: {
            variantId: id,
            revision: v.revision,
            scheduledAt: v.scheduled_at,
            dispatchedAt: now.toISOString(),
            exactPayload: p,
          },
        });
        await db.query(
          "UPDATE post_variant SET status='would_have_sent',updated_at=now() WHERE id=$1",
          [id],
        );
      });
      return;
    }
    if (mode === "manual") {
      const result = await channelAdapter("manual").publish(p);
      await terminal(result.outcome, result.reason ?? null);
      return;
    }
    if (
      !factory &&
      v.platform === "tiktok" &&
      !v.granted_scopes.includes(
        p.tiktok?.mode === "direct" ? "video.publish" : "video.upload",
      )
    ) {
      await terminal("needs_action", "TIKTOK_PERMISSION_MISSING");
      return;
    }
    if (
      !factory &&
      v.platform === "facebook" &&
      (!v.granted_scopes.includes("pages_manage_posts") ||
        !v.granted_scopes.includes("pages_read_engagement") ||
        (p.firstComment &&
          !v.granted_scopes.includes("pages_manage_engagement")))
    ) {
      await terminal("needs_action", "META_PERMISSION_MISSING");
      return;
    }
    await pool.query(
      "UPDATE post_variant SET status='publishing',updated_at=now() WHERE id=$1",
      [id],
    );
    const step: Step = async (name, payload, send) => {
      await authorized();
      const existing = (
        await pool.query(
          "SELECT * FROM publish_step WHERE business_id=$1 AND variant_id=$2 AND revision=$3 AND name=$4",
          [v.business_id, id, v.revision, name],
        )
      ).rows[0];
      if (existing?.status === "succeeded") return existing.result;
      if (existing) throw new AppError(409, "EXTERNAL_OUTCOME_UNKNOWN");
      const stepId = randomUUID();
      await transaction(pool, async (db) => {
        await db.query(
          "INSERT INTO publish_step(id,business_id,variant_id,revision,name,payload,status) VALUES($1,$2,$3,$4,$5,$6,'started')",
          [stepId, v.business_id, id, v.revision, name, payload],
        );
        await audit(db, {
          businessId: v.business_id,
          actorId: v.scheduled_by,
          actorType: "worker",
          channelId: v.channel_id,
          action: "publish.attempt_started",
          payload: {
            variantId: id,
            revision: v.revision,
            step: name,
            exactPayload: payload,
          },
        });
      });
      const result = await send();
      await transaction(pool, async (db) => {
        await db.query(
          "UPDATE publish_step SET status='succeeded',result=$2,updated_at=now() WHERE id=$1",
          [stepId, JSON.stringify(result)],
        );
        await audit(db, {
          businessId: v.business_id,
          actorId: v.scheduled_by,
          actorType: "worker",
          channelId: v.channel_id,
          action: "publish.attempt_succeeded",
          payload: {
            variantId: id,
            revision: v.revision,
            step: name,
            platformId:
              (result as any)?.id ?? (result as any)?.video_id ?? null,
          },
        });
      });
      return result;
    };
    try {
      const transport = factory
        ? factory(step)
        : channelAdapter(v.platform, {
            config: c,
            credentials: decrypt(
              v.credentials_encrypted,
              `${v.business_id}:channel:${v.channel_id}`,
              c,
            ),
            channel: v,
            step,
            file: async (m) => {
              const asset = (
                await pool.query(
                  "SELECT storage_key FROM media_asset WHERE business_id=$1 AND id=$2",
                  [v.business_id, m.id],
                )
              ).rows[0];
              if (!asset) throw new AppError(409, "MEDIA_MISSING");
              const path = mediaPath(c, asset.storage_key);
              const h = createHash("sha256");
              for await (const b of createReadStream(path)) h.update(b);
              if (h.digest("hex") !== m.sha256)
                throw new AppError(409, "MEDIA_HASH_MISMATCH");
              return path;
            },
          });
      const result = await transport.publish(p);
      await terminal(
        result.outcome,
        result.reason ?? null,
        result.platformId,
        result.permalink,
      );
    } catch (e) {
      await terminal(
        "needs_action",
        e instanceof AppError ? e.code : "EXTERNAL_OUTCOME_UNKNOWN",
      );
    }
    async function terminal(
      status: string,
      error: string | null,
      platformId?: string,
      permalink?: string,
    ) {
      await transaction(pool, async (db) => {
        await db.query(
          "UPDATE post_variant SET status=$2,error=$3,platform_id=coalesce($4,platform_id),permalink=coalesce($5,permalink),updated_at=now() WHERE id=$1",
          [id, status, error, platformId ?? null, permalink ?? null],
        );
        await audit(db, {
          businessId: v.business_id,
          actorId: v.scheduled_by,
          actorType: "worker",
          channelId: v.channel_id,
          action: `post.${status}`,
          payload: {
            variantId: id,
            revision: v.revision,
            error,
            platformId,
            permalink,
          },
        });
      });
    }
  } finally {
    if (locked)
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `publish:${id}`,
      ]);
    lock.release();
  }
}
