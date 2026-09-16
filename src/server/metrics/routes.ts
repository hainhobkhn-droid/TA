import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { transaction, type PgPool } from "../db/index.js";
import { actorFor, requirePermission, type Auth } from "../auth/index.js";
import { report } from "./service.js";
import { AppError } from "../errors.js";
import { audit } from "../audit/index.js";
import { generateInsights } from "../advisor/service.js";
export async function metricsRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
  c: Config,
) {
  app.get("/api/reports", async (req) => {
    const a = await actorFor(auth, pool, req);
    const q = z
      .object({
        days: z.coerce
          .number()
          .refine((x) => [1, 7, 28, 90].includes(x))
          .default(28),
        channelId: z.string().uuid().optional(),
      })
      .parse(req.query);
    return {
      ...(await report(pool, a, q.days, q.channelId)),
      enabled: c.AUDIENCE_METRICS_ENABLED,
    };
  });
  app.get("/api/insights", async (req) => {
    const a = await actorFor(auth, pool, req);
    return {
      insights: (
        await pool.query(
          "SELECT i.*,c.display_name,c.platform FROM insight i JOIN channel c ON c.id=i.channel_id WHERE i.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) ORDER BY i.period_end DESC,i.created_at DESC LIMIT 100",
          [a.businessId, a.channelScope.includes("*"), a.channelScope],
        )
      ).rows,
    };
  });
  app.post("/api/insights/refresh", async (req) => {
    const a = await actorFor(auth, pool, req);
    if (!["owner", "manager"].includes(a.role))
      throw new AppError(403, "FORBIDDEN");
    const channels = (
      await pool.query(
        "SELECT id FROM channel WHERE business_id=$1 AND ($2 OR platform=ANY($3::text[]))",
        [a.businessId, a.channelScope.includes("*"), a.channelScope],
      )
    ).rows;
    let count = 0;
    for (const ch of channels)
      count += await generateInsights(pool, a.businessId, ch.id);
    await audit(pool, {
      businessId: a.businessId,
      actorId: a.userId,
      action: "insights.refreshed",
      payload: { count },
    });
    return { count };
  });
  app.post("/api/insights/:id/dismiss", async (req) => {
    const a = await actorFor(auth, pool, req);
    if (!["owner", "manager"].includes(a.role))
      throw new AppError(403, "FORBIDDEN");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await transaction(pool, async (db) => {
      const r = await db.query(
        "UPDATE insight i SET status='dismissed' FROM channel c WHERE i.id=$1 AND i.business_id=$2 AND c.id=i.channel_id AND ($3 OR c.platform=ANY($4::text[])) RETURNING i.id",
        [id, a.businessId, a.channelScope.includes("*"), a.channelScope],
      );
      if (!r.rowCount) throw new AppError(404, "NOT_FOUND");
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "insight.dismissed",
        payload: { id },
      });
    });
    return { ok: true };
  });
  app.get("/api/digest/preferences", async (req) => {
    const a = await actorFor(auth, pool, req);
    return (
      await pool.query(
        "SELECT digest_email,digest_sms FROM user_preference WHERE user_id=$1",
        [a.userId],
      )
    ).rows[0];
  });
  app.post("/api/digest/preferences", async (req) => {
    const a = await actorFor(auth, pool, req);
    const p = z
      .object({ email: z.boolean(), sms: z.boolean() })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      await db.query(
        "UPDATE user_preference SET digest_email=$2,digest_sms=$3 WHERE user_id=$1",
        [a.userId, p.email, p.sms],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "digest.preferences_updated",
        payload: p,
      });
    });
    return { ok: true };
  });
  app.post("/api/inbox/:id/order", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { orderId } = z
      .object({ orderId: z.string().min(1).max(100) })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const v = (
        await db.query(
          "SELECT v.*,c.platform FROM conversation v JOIN channel c ON c.id=v.channel_id WHERE v.id=$1 AND v.business_id=$2",
          [id, a.businessId],
        )
      ).rows[0];
      if (!v) throw new AppError(404, "NOT_FOUND");
      requirePermission(a, "replies.write", v.platform);
      const orders = (
        await db.query(
          "SELECT v.* FROM knowledge_current k JOIN knowledge_version v ON v.id=k.version_id JOIN knowledge_source s ON s.id=k.source_id WHERE k.business_id=$1 AND s.dataset='orders' AND v.data->>'order_id'=$2",
          [a.businessId, orderId],
        )
      ).rows;
      if (orders.length !== 1)
        throw new AppError(400, "ORDER_MISSING_OR_AMBIGUOUS");
      const o = orders[0];
      const result = await db.query(
        "INSERT INTO inquiry_order_link(id,business_id,conversation_id,order_version_id,source_id,record_key,linked_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
        [
          randomUUID(),
          a.businessId,
          id,
          o.id,
          o.source_id,
          o.record_key,
          a.userId,
        ],
      );
      if (!result.rowCount) throw new AppError(409, "ORDER_ALREADY_LINKED");
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: v.channel_id,
        action: "order.attribution_confirmed",
        payload: { conversationId: id, orderVersionId: o.id, orderId },
      });
      return { ok: true };
    });
  });
}
