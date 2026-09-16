import { can } from "../../shared/permissions.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { z } from "zod";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { transaction, type PgPool } from "../db/index.js";
import { actorFor, requirePermission, type Auth } from "../auth/index.js";
import { AppError } from "../errors.js";
import { audit } from "../audit/index.js";
import { ingestMessage } from "./service.js";
import { loadRules } from "../rules/service.js";
import { normalize } from "./engine.js";
import { channelAdapter } from "../channels/adapter.js";
export async function inboxRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
  c: Config,
) {
  app.get("/api/inbox", async (req) => {
    const a = await actorFor(auth, pool, req);
    if (
      !can(
        a.role,
        a.channelScope,
        "replies.write",
        undefined,
        a.deniedPermissions,
      ) &&
      !can(
        a.role,
        a.channelScope,
        "approvals.write",
        undefined,
        a.deniedPermissions,
      )
    )
      throw new AppError(403, "FORBIDDEN");
    const q = z
      .object({
        filter: z
          .enum(["all", "mine", "needs_approval", "escalated"])
          .default("all"),
      })
      .parse(req.query);
    return {
      conversations: (
        await pool.query(
          `SELECT v.*,c.platform,c.display_name,m.text AS latest_text,d.id AS draft_id,d.status AS draft_status,d.analysis,d.checks,d.created_at AS waiting_since FROM conversation v JOIN channel c ON c.id=v.channel_id LEFT JOIN LATERAL(SELECT * FROM message WHERE conversation_id=v.id AND NOT from_business ORDER BY sent_at DESC LIMIT 1)m ON true LEFT JOIN reply_draft d ON d.message_id=m.id WHERE v.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND ($4<>'mine' OR v.assigned_to=$5) AND ($4<>'needs_approval' OR d.status='needs_approval') AND ($4<>'escalated' OR d.autonomy='human_only') ORDER BY coalesce(m.sent_at,v.created_at) DESC LIMIT 200`,
          [
            a.businessId,
            a.channelScope.includes("*"),
            a.channelScope,
            q.filter,
            a.userId,
          ],
        )
      ).rows,
    };
  });
  async function conversation(req: any) {
    const a = await actorFor(auth, pool, req);
    if (
      !can(
        a.role,
        a.channelScope,
        "replies.write",
        undefined,
        a.deniedPermissions,
      ) &&
      !can(
        a.role,
        a.channelScope,
        "approvals.write",
        undefined,
        a.deniedPermissions,
      )
    )
      throw new AppError(403, "FORBIDDEN");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const v = (
      await pool.query(
        "SELECT v.*,c.platform,c.display_name,c.mode FROM conversation v JOIN channel c ON c.id=v.channel_id WHERE v.business_id=$1 AND v.id=$2",
        [a.businessId, id],
      )
    ).rows[0];
    if (!v) throw new AppError(404, "NOT_FOUND");
    if (
      !can(
        a.role,
        a.channelScope,
        "replies.write",
        v.platform,
        a.deniedPermissions,
      ) &&
      !can(
        a.role,
        a.channelScope,
        "approvals.write",
        v.platform,
        a.deniedPermissions,
      )
    )
      throw new AppError(403, "FORBIDDEN");
    return { a, v };
  }
  app.get("/api/inbox/:id", async (req) => {
    const { a, v } = await conversation(req);
    return {
      conversation: v,
      messages: (
        await pool.query(
          "SELECT * FROM message WHERE business_id=$1 AND conversation_id=$2 ORDER BY sent_at",
          [a.businessId, v.id],
        )
      ).rows,
      drafts: (
        await pool.query(
          "SELECT * FROM reply_draft WHERE business_id=$1 AND conversation_id=$2 ORDER BY created_at",
          [a.businessId, v.id],
        )
      ).rows,
      deliveries: (
        await pool.query(
          "SELECT x.* FROM reply_delivery x JOIN reply_draft d ON d.id=x.draft_id WHERE d.business_id=$1 AND d.conversation_id=$2 ORDER BY x.created_at",
          [a.businessId, v.id],
        )
      ).rows,
    };
  });
  app.post("/api/inbox/manual", async (req) => {
    const a = await actorFor(auth, pool, req);
    const b = z
      .object({
        channelId: z.string().uuid(),
        customerId: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(4000),
        threadId: z.string().max(200).optional(),
      })
      .strict()
      .parse(req.body);
    const ch = (
      await pool.query("SELECT * FROM channel WHERE business_id=$1 AND id=$2", [
        a.businessId,
        b.channelId,
      ])
    ).rows[0];
    if (!ch) throw new AppError(404, "NOT_FOUND");
    requirePermission(a, "replies.write", ch.platform);
    return transaction(pool, async (db) => {
      const result = await ingestMessage(db, {
        businessId: a.businessId,
        channelId: b.channelId,
        threadId: "manual:" + (b.threadId ?? randomUUID()),
        customerId: b.customerId,
        externalId: randomUUID(),
        kind: "manual",
        text: b.text,
        sentAt: new Date().toISOString(),
      });
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: b.channelId,
        action: "inquiry.manual_created",
        payload: result,
      });
      return result;
    });
  });
  app.post("/api/inbox/:id/messages", async (req) => {
    const { a, v } = await conversation(req);
    requirePermission(a, "replies.write", v.platform);
    if (v.kind !== "manual") throw new AppError(409, "MANUAL_THREAD_REQUIRED");
    const { text } = z
      .object({ text: z.string().trim().min(1).max(4000) })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const result = await ingestMessage(db, {
        businessId: a.businessId,
        channelId: v.channel_id,
        threadId: v.external_id,
        customerId: v.customer_id,
        externalId: randomUUID(),
        kind: "manual",
        text,
        sentAt: new Date().toISOString(),
      });
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: v.channel_id,
        action: "inquiry.manual_added",
        payload: result,
      });
      return result;
    });
  });
  app.patch("/api/inbox/:id", async (req) => {
    const { a, v } = await conversation(req);
    requirePermission(a, "replies.write", v.platform);
    const b = z
      .object({
        status: z.enum(["open", "resolved"]).optional(),
        assignToMe: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      await db.query(
        "UPDATE conversation SET status=coalesce($2,status),resolved_at=CASE WHEN $2='resolved' THEN now() WHEN $2='open' THEN NULL ELSE resolved_at END,assigned_to=CASE WHEN $3 THEN $4 ELSE assigned_to END WHERE id=$1",
        [v.id, b.status ?? null, b.assignToMe ?? false, a.userId],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: v.channel_id,
        action: "conversation.updated",
        payload: { id: v.id, ...b },
      });
    });
    return { ok: true };
  });
  app.post("/api/replies/:id/approve", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        text: z.string().trim().min(1).max(2000),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const { rules } = await loadRules(pool, a.businessId);
    if (
      rules.forbidden_claims.some((p) =>
        normalize(b.text).includes(normalize(p)),
      )
    )
      throw new AppError(400, "FORBIDDEN_CLAIM");
    return transaction(pool, async (db) => {
      const d = (
        await db.query(
          "SELECT d.*,v.channel_id,c.platform FROM reply_draft d JOIN conversation v ON v.id=d.conversation_id JOIN channel c ON c.id=v.channel_id WHERE d.id=$1 AND d.business_id=$2 FOR UPDATE OF d",
          [id, a.businessId],
        )
      ).rows[0];
      if (!d) throw new AppError(404, "NOT_FOUND");
      requirePermission(a, "approvals.write", d.platform);
      if (
        d.revision !== b.revision ||
        !["needs_approval", "queued"].includes(d.status)
      )
        throw new AppError(409, "REVISION_CONFLICT");
      await db.query(
        "INSERT INTO reply_edit(id,business_id,draft_id,draft_text,final_text,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), a.businessId, id, d.text, b.text, a.userId],
      );
      await db.query(
        "UPDATE reply_draft SET checks=jsonb_set(checks,'{humanEdited}',to_jsonb(text<>$2)),text=$2,revision=revision+1,status='approved',approved_by=$3,approved_at=now(),updated_at=now() WHERE id=$1",
        [id, b.text, a.userId],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: d.channel_id,
        action: "reply.approved",
        payload: {
          draftId: id,
          revision: b.revision + 1,
          originalText: d.text,
          finalText: b.text,
          facts: d.facts,
        },
      });
      return { ok: true };
    });
  });
  app.get("/api/notifications", async (req) => {
    const a = await actorFor(auth, pool, req);
    return {
      notifications: (
        await pool.query(
          "SELECT n.* FROM notification n LEFT JOIN channel c ON c.id=n.channel_id WHERE n.business_id=$1 AND n.user_id=$2 AND n.transport='in_app' AND ($3 OR c.platform=ANY($4::text[]) OR n.channel_id IS NULL) ORDER BY created_at DESC LIMIT 50",
          [
            a.businessId,
            a.userId,
            a.channelScope.includes("*"),
            a.channelScope,
          ],
        )
      ).rows,
    };
  });
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => done(null, body),
    );
    webhook.get("/webhooks/meta", async (req, reply) => {
      const q = z
        .object({
          "hub.mode": z.literal("subscribe"),
          "hub.verify_token": z.string().max(300),
          "hub.challenge": z.string().max(200),
        })
        .parse(req.query);
      if (
        !c.META_WEBHOOK_VERIFY_TOKEN ||
        !timingSafeEqual(
          createHash("sha256").update(q["hub.verify_token"]).digest(),
          createHash("sha256").update(c.META_WEBHOOK_VERIFY_TOKEN).digest(),
        )
      )
        throw new AppError(403, "WEBHOOK_VERIFY_FAILED");
      return reply.type("text/plain").send(q["hub.challenge"]);
    });
    webhook.post(
      "/webhooks/meta",
      { bodyLimit: 1048576 },
      async (req, reply) => {
        const raw = req.body as Buffer;
        if (
          !Buffer.isBuffer(raw) ||
          !channelAdapter("facebook", { config: c }).verifyWebhook(raw, {
            "x-hub-signature-256": req.headers["x-hub-signature-256"] as string,
          })
        )
          throw new AppError(403, "WEBHOOK_SIGNATURE_INVALID");
        let payload;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new AppError(400, "INVALID_WEBHOOK");
        }
        await pool.query(
          "INSERT INTO webhook_event(id,provider,body_hash,payload) VALUES($1,'facebook',$2,$3) ON CONFLICT(body_hash) DO NOTHING",
          [
            randomUUID(),
            createHash("sha256").update(raw).digest("hex"),
            payload,
          ],
        );
        return reply.code(200).send({ received: true });
      },
    );
  });
}
export const webhookMaxAttempts = 6;
export async function processWebhooks(pool: PgPool, now = new Date()) {
  const events = (
    await pool.query(
      "SELECT * FROM webhook_event WHERE status='pending' AND next_attempt_at<=$1 ORDER BY next_attempt_at,received_at LIMIT 20",
      [now],
    )
  ).rows;
  for (const e of events) {
    try {
      await transaction(pool, async (db) => {
        const current = await db.query(
          "SELECT id FROM webhook_event WHERE id=$1 AND status='pending' AND attempts=$2 AND next_attempt_at<=$3 FOR UPDATE SKIP LOCKED",
          [e.id, e.attempts, now],
        );
        if (!current.rowCount) return;
        for (const m of await channelAdapter("facebook").fetchInbox(
          e.payload,
        )) {
          const ch = (
            await db.query(
              "SELECT * FROM channel WHERE platform='facebook' AND external_id=$1 AND status='connected'",
              [m.pageId],
            )
          ).rows[0];
          if (!ch) continue;
          await ingestMessage(db, {
            businessId: ch.business_id,
            channelId: ch.id,
            ...m,
          });
        }
        await db.query(
          "UPDATE webhook_event SET status='processed',attempts=attempts+1,last_attempt_at=$2,error=NULL WHERE id=$1",
          [e.id, now],
        );
      });
    } catch {
      const attempt = e.attempts + 1;
      const retryAt = new Date(
        +now + Math.min(30 * 2 ** (attempt - 1), 1800) * 1000,
      );
      // The ingestion transaction rolled back. Fence this update against another
      // worker succeeding or recording the same failed attempt in the meantime.
      await pool.query(
        "UPDATE webhook_event SET status=$2,attempts=attempts+1,last_attempt_at=$3,next_attempt_at=$4,error='WEBHOOK_PROCESSING_FAILED' WHERE id=$1 AND status='pending' AND attempts=$5",
        [
          e.id,
          attempt >= webhookMaxAttempts ? "failed" : "pending",
          now,
          retryAt,
          e.attempts,
        ],
      );
    }
  }
}
