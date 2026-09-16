import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { PgPool } from "../db/index.js";
import { transaction } from "../db/index.js";
import { actorFor, requirePermission, type Auth } from "../auth/index.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
import {
  variantSchema,
  validatePublish,
  businessInstant,
} from "../../shared/publishing.js";
import { postSchema, createPost, editVariant } from "./service.js";
import { uploadMedia, mediaPath } from "../media/service.js";
import type { PgBoss } from "pg-boss";
export async function publisherRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
  c: Config,
  boss: PgBoss,
) {
  app.addContentTypeParser("application/octet-stream", (req, payload, done) =>
    done(null, payload),
  );
  app.patch("/api/publishing/pause", async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "settings.write");
    const { paused } = z
      .object({ paused: z.boolean() })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      await db.query("UPDATE business SET publishing_paused=$2 WHERE id=$1", [
        a.businessId,
        paused,
      ]);
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "publishing.pause_changed",
        payload: { paused },
      });
    });
    return { ok: true };
  });
  app.get("/api/media", async (req) => {
    const a = await actorFor(auth, pool, req);
    return {
      assets: (
        await pool.query(
          "SELECT id,name,scope,sha256,bytes,mime,status,metadata,error,parent_id,created_at FROM media_asset WHERE business_id=$1 AND ($2 OR scope <@ $3::text[]) ORDER BY created_at DESC LIMIT 100",
          [a.businessId, a.channelScope.includes("*"), a.channelScope],
        )
      ).rows,
    };
  });
  app.post("/api/media", { bodyLimit: c.MEDIA_MAX_BYTES }, async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "posts.write");
    const q = z
      .object({
        name: z.string().trim().min(1).max(200),
        scope: z.string().default("facebook"),
      })
      .parse(req.query);
    const scope = [...new Set(q.scope.split(","))];
    if (!scope.length || scope.some((p) => !["facebook", "tiktok"].includes(p)))
      throw new AppError(400, "INVALID_SCOPE");
    for (const p of scope) requirePermission(a, "posts.write", p);
    if (req.headers["content-type"] !== "application/octet-stream")
      throw new AppError(400, "BINARY_REQUIRED");
    return uploadMedia(pool, c, a, req.body as Readable, q.name, scope);
  });
  async function asset(req: any) {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const m = (
      await pool.query(
        "SELECT * FROM media_asset WHERE business_id=$1 AND id=$2 AND ($3 OR scope <@ $4::text[])",
        [a.businessId, id, a.channelScope.includes("*"), a.channelScope],
      )
    ).rows[0];
    if (!m) throw new AppError(404, "NOT_FOUND");
    return { a, m };
  }
  app.get("/api/media/:id/file", async (req, reply) => {
    const { m } = await asset(req);
    reply.header("content-disposition", "attachment");
    return reply
      .type(m.mime)
      .send(createReadStream(mediaPath(c, m.storage_key)));
  });
  app.get("/api/media/:id/thumbnail", async (req, reply) => {
    const { m } = await asset(req);
    if (m.status !== "ready") throw new AppError(404, "NOT_READY");
    return reply
      .type("image/jpeg")
      .send(createReadStream(mediaPath(c, m.id + ".jpg")));
  });
  app.post("/api/media/:id/rendition", async (req) => {
    const { a, m } = await asset(req);
    for (const p of m.scope) requirePermission(a, "posts.write", p);
    if (
      m.status !== "ready" ||
      !m.mime.startsWith("video/") ||
      m.metadata.duration > 90 ||
      m.metadata.duration < 3
    )
      throw new AppError(400, "REEL_DURATION_3_90");
    await transaction(pool, async (db) => {
      await boss.send(
        "helpa-media-rendition",
        { businessId: a.businessId, assetId: m.id, actorId: a.userId },
        { db: { executeSql: (t, v) => db.query(t, v) }, singletonKey: m.id },
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "media.rendition_requested",
        payload: { id: m.id },
      });
    });
    return { queued: true };
  });
  app.get("/api/posts", async (req) => {
    const a = await actorFor(auth, pool, req);
    const rows = (
      await pool.query(
        `SELECT v.*,p.title,c.platform,c.display_name,c.mode,r.payload,b.posts_require_approval FROM post_variant v JOIN post p ON p.id=v.post_id JOIN channel c ON c.id=v.channel_id JOIN business b ON b.id=v.business_id JOIN post_revision r ON r.variant_id=v.id AND r.revision=v.revision WHERE v.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) ORDER BY coalesce(v.scheduled_at,p.created_at) DESC LIMIT 500`,
        [a.businessId, a.channelScope.includes("*"), a.channelScope],
      )
    ).rows;
    return {
      paused: (
        await pool.query("SELECT publishing_paused FROM business WHERE id=$1", [
          a.businessId,
        ])
      ).rows[0].publishing_paused,
      variants: rows.map((v) => ({
        ...v,
        validation: validatePublish(v.payload),
      })),
    };
  });
  app.post("/api/posts", async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "posts.write");
    const input = postSchema.parse(req.body);
    return transaction(pool, (db) => createPost(db, a, input));
  });
  app.patch("/api/posts/:id", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        expectedRevision: z.number().int().positive(),
        variant: variantSchema,
      })
      .strict()
      .parse(req.body);
    return editVariant(pool, a, id, b.expectedRevision, b.variant);
  });
  app.post("/api/posts/:id/approve", async (req) => {
    const a = await actorFor(auth, pool, req);
    if (!["owner", "manager"].includes(a.role))
      throw new AppError(403, "FORBIDDEN");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const v = (
        await db.query(
          "SELECT v.*,c.platform,r.payload FROM post_variant v JOIN channel c ON c.id=v.channel_id JOIN post_revision r ON r.variant_id=v.id AND r.revision=v.revision WHERE v.business_id=$1 AND v.id=$2 FOR UPDATE OF v",
          [a.businessId, id],
        )
      ).rows[0];
      if (!v) throw new AppError(404, "NOT_FOUND");
      requirePermission(a, "approvals.write", v.platform);
      if (v.revision !== revision || !["draft", "scheduled"].includes(v.status))
        throw new AppError(409, "REVISION_CONFLICT");
      const errs = validatePublish(v.payload);
      if (errs.length) throw new AppError(400, errs[0]);
      await db.query(
        "UPDATE post_variant SET approved_revision=$3,approved_by=$4 WHERE business_id=$1 AND id=$2",
        [a.businessId, id, revision, a.userId],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: v.channel_id,
        action: "post.approved",
        payload: { variantId: id, revision, exactPayload: v.payload },
      });
      return { ok: true };
    });
  });
  app.post("/api/posts/:id/resume", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const v = (
        await db.query(
          "SELECT v.*,c.platform FROM post_variant v JOIN channel c ON c.id=v.channel_id WHERE v.id=$1 AND v.business_id=$2 FOR UPDATE OF v",
          [id, a.businessId],
        )
      ).rows[0];
      if (!v) throw new AppError(404, "NOT_FOUND");
      requirePermission(a, "posts.write", v.platform);
      if (v.revision !== revision || v.status !== "needs_action")
        throw new AppError(409, "REVISION_CONFLICT");
      const uncertain = await db.query(
        "SELECT 1 FROM publish_step WHERE variant_id=$1 AND revision=$2 AND status<>'succeeded'",
        [id, revision],
      );
      if (uncertain.rowCount)
        throw new AppError(409, "RECONCILE_EXTERNAL_OUTCOME_FIRST");
      await db.query(
        "UPDATE post_variant SET status='scheduled',error=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: v.channel_id,
        action: "post.resume_requested",
        payload: { variantId: id, revision },
      });
      return { ok: true };
    });
  });
  app.get("/api/posts/:id/attempts", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const v = (
      await pool.query(
        "SELECT c.platform FROM post_variant v JOIN channel c ON c.id=v.channel_id WHERE v.id=$1 AND v.business_id=$2",
        [id, a.businessId],
      )
    ).rows[0];
    if (
      !v ||
      (!a.channelScope.includes("*") && !a.channelScope.includes(v.platform))
    )
      throw new AppError(404, "NOT_FOUND");
    return {
      steps: (
        await pool.query(
          `SELECT name,payload,status,jsonb_build_object('id',result->'id','video_id',result->'video_id','success',result->'success') AS result,error,created_at FROM publish_step WHERE business_id=$1 AND variant_id=$2 ORDER BY created_at`,
          [a.businessId, id],
        )
      ).rows,
    };
  });
  app.post("/api/posts/:id/manual-complete", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        permalink: z.string().url(),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const v = (
        await db.query(
          "SELECT v.*,c.platform FROM post_variant v JOIN channel c ON c.id=v.channel_id WHERE v.id=$1 AND v.business_id=$2 FOR UPDATE OF v",
          [id, a.businessId],
        )
      ).rows[0];
      if (!v) throw new AppError(404, "NOT_FOUND");
      requirePermission(a, "posts.write", v.platform);
      if (v.status !== "needs_action" || v.revision !== b.revision)
        throw new AppError(409, "REVISION_CONFLICT");
      const u = new URL(b.permalink);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        !(
          v.platform === "facebook"
            ? ["facebook.com", "www.facebook.com"]
            : ["www.tiktok.com", "tiktok.com"]
        ).includes(u.hostname)
      )
        throw new AppError(400, "INVALID_PERMALINK");
      await db.query(
        "UPDATE post_variant SET status='published',permalink=$3,error='MANUALLY_CONFIRMED',updated_at=now() WHERE business_id=$1 AND id=$2",
        [a.businessId, id, b.permalink],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: v.channel_id,
        action: "post.manually_confirmed",
        payload: {
          variantId: id,
          revision: b.revision,
          permalink: b.permalink,
        },
      });
      return { ok: true };
    });
  });
  app.get("/api/recurring", async (req) => {
    const a = await actorFor(auth, pool, req);
    return {
      templates: (
        await pool.query(
          `SELECT * FROM recurring_template t WHERE business_id=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.variants) v JOIN channel c ON c.id=(v->>'channelId')::uuid WHERE NOT($2 OR c.platform=ANY($3::text[]))) ORDER BY created_at DESC`,
          [a.businessId, a.channelScope.includes("*"), a.channelScope],
        )
      ).rows,
    };
  });
  app.post("/api/recurring", async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "posts.write");
    const b = postSchema
      .extend({
        weekday: z.number().int().min(0).max(6),
        localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        weeks: z.number().int().min(1).max(12).default(4),
      })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO recurring_template(id,business_id,title,created_by,weekday,local_time,variants) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          a.businessId,
          b.title,
          a.userId,
          b.weekday,
          b.localTime,
          JSON.stringify(b.variants),
        ],
      );
      const now = Date.now();
      const local = new Date(now + 7 * 3600000);
      local.setUTCHours(0, 0, 0, 0);
      let count = 0;
      for (let d = 0; count < b.weeks && d < 90; d++) {
        const day = new Date(+local + d * 86400000);
        if (day.getUTCDay() !== b.weekday) continue;
        const date = day.toISOString().slice(0, 10);
        const at = businessInstant(date + "T" + b.localTime);
        if (+new Date(at) <= now) continue;
        const p = await createPost(db, a, {
          title: b.title,
          variants: b.variants.map((v) => ({ ...v, scheduledAt: at })),
        });
        await db.query(
          "INSERT INTO recurring_occurrence(business_id,template_id,local_date,post_id) VALUES($1,$2,$3,$4)",
          [a.businessId, id, date, p.id],
        );
        count++;
      }
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "post.recurring_expanded",
        payload: { id, count },
      });
      return { id, count };
    });
  });
  app.patch("/api/channels/:id/mode", async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "channels.connect");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { mode } = z
      .object({ mode: z.enum(["manual", "dry_run", "live"]) })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      const ch = (
        await db.query(
          "SELECT * FROM channel WHERE business_id=$1 AND id=$2 FOR UPDATE",
          [a.businessId, id],
        )
      ).rows[0];
      if (!ch) throw new AppError(404, "NOT_FOUND");
      requirePermission(a, "channels.connect", ch.platform);
      if (mode === "live" && ch.status !== "connected")
        throw new AppError(409, "CHANNEL_NOT_CONNECTED");
      await db.query(
        "UPDATE channel SET mode=$3 WHERE business_id=$1 AND id=$2",
        [a.businessId, id, mode],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        channelId: id,
        action: "channel.mode_changed",
        payload: { mode, globalMode: c.HELPA_MODE },
      });
    });
    return { ok: true };
  });
}
