import { metricsRoutes } from "./metrics/routes.js";
import { advisorRoutes } from "./advisor/routes.js";
import { auditRoutes } from "./audit/routes.js";
import { teamRoutes } from "./team/routes.js";
import type { SmsProvider } from "./team/access.js";
import Fastify, {
  LogController,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { PgBoss } from "pg-boss";
import type { Config } from "./config.js";
import { Pool, transaction, type PgPool } from "./db/index.js";
import { createAuth, actorFor, requirePermission } from "./auth/index.js";
import { audit } from "./audit/index.js";
import { encrypt, decrypt } from "./channels/crypto.js";
import {
  facebookConnection,
  type FacebookConnection,
  type FacebookPage,
} from "./channels/facebook.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { inboxRoutes } from "./inbox/routes.js";
import { tiktokRoutes } from "./channels/tiktok.js";
import { publisherRoutes } from "./scheduler/routes.js";
import { AppError } from "./errors.js";
import { startQueue, probeQueue } from "./queue.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const channelSelect =
  "id,platform,external_id,display_name,mode,status,token_expires_at,token_expiry_kind,granted_scopes,capabilities,connected_at,token_checked_at,maintenance_error";
const authPaths = new Set([
  "/sign-in/email",
  "/sign-out",
  "/two-factor/enable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);
function responseCookies(response: Response) {
  return response.headers.getSetCookie();
}
function sessionHeaders(req: FastifyRequest, response: Response) {
  const headers = fromNodeHeaders(req.headers);
  const cookies = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const pos = part.indexOf("=");
    if (pos > 0) cookies.set(part.slice(0, pos).trim(), part.slice(pos + 1));
  }
  for (const value of responseCookies(response)) {
    const part = value.split(";")[0];
    const pos = part.indexOf("=");
    if (pos > 0) cookies.set(part.slice(0, pos), part.slice(pos + 1));
  }
  headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  return headers;
}
async function forwardAuth(reply: FastifyReply, response: Response) {
  const cookies = responseCookies(response);
  if (cookies.length) reply.header("set-cookie", cookies);
  const body = (await response
    .json()
    .catch(() => ({ error: "AUTH_FAILED" }))) as Record<string, unknown>;
  delete body.token;
  return reply.code(response.status).send(body);
}

export async function buildApp(
  c: Config,
  options: {
    pool?: PgPool;
    sms?: SmsProvider;
    boss?: PgBoss;
    facebook?: FacebookConnection;
    serveWeb?: boolean;
  } = {},
) {
  const pool =
    options.pool ?? new Pool({ connectionString: c.DATABASE_URL, max: 8 });
  const boss = options.boss ?? (await startQueue(c));
  const auth = createAuth(pool, c, options.sms);
  const facebook = options.facebook ?? facebookConnection(c);
  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: c.LOG_LEVEL,
      redact: ["req.headers", "res.headers", "req.body", "err"],
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: c.PUBLIC_URL.startsWith("https:") ? [] : null,
      },
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api")) reply.header("cache-control", "no-store");
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !(req.method === "POST" && req.url.split("?")[0] === "/webhooks/meta") &&
      req.headers.origin !== c.PUBLIC_URL
    )
      throw new AppError(403, "ORIGIN_REJECTED");
  });
  app.setErrorHandler((e, req, reply) => {
    if (e instanceof AppError)
      return reply.code(e.status).send({ error: e.code });
    if (e instanceof z.ZodError)
      return reply.code(400).send({
        error: "INVALID_INPUT",
        fields: e.issues.map((i) => i.path.join(".")),
      });
    app.log.error(
      { event: "request_failed", requestId: req.id },
      "Request failed",
    );
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  });
  async function limited(key: string, max = 10) {
    const r = await pool.query(
      `INSERT INTO login_limit(key,attempts,resets_at) VALUES($1,1,now()+interval '15 minutes')
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limit.resets_at<now() THEN 1 ELSE login_limit.attempts+1 END,
      resets_at=CASE WHEN login_limit.resets_at<now() THEN now()+interval '15 minutes' ELSE login_limit.resets_at END RETURNING attempts`,
      [hash(key)],
    );
    if (r.rows[0].attempts > max) throw new AppError(429, "RATE_LIMITED");
  }
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/api/bootstrap/status", async () => ({
    required: !(await pool.query("SELECT 1 FROM business LIMIT 1")).rowCount,
  }));
  app.post("/api/bootstrap", async (req, reply) => {
    await limited(`bootstrap:${req.ip}`, 5);
    const body = z
      .object({
        token: z.string().max(200),
        email: z.string().email().max(254),
        password: z.string().min(12).max(128),
        name: z.string().trim().min(1).max(100),
        businessName: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    if (
      !timingSafeEqual(
        Buffer.from(hash(body.token)),
        Buffer.from(hash(c.BOOTSTRAP_TOKEN)),
      )
    )
      throw new AppError(403, "BOOTSTRAP_TOKEN_INVALID");
    const lock = await pool.connect();
    let newUserId: string | undefined;
    try {
      await lock.query("SELECT pg_advisory_lock(781210)");
      if ((await lock.query("SELECT 1 FROM business")).rowCount)
        throw new AppError(409, "ALREADY_INITIALIZED");
      const response = await auth.api.signUpEmail({
        body: { email: body.email, password: body.password, name: body.name },
        headers: fromNodeHeaders(req.headers),
        asResponse: true,
      });
      if (!response.ok) return forwardAuth(reply, response);
      const result = (await response.clone().json()) as {
        user: { id: string };
      };
      newUserId = result.user.id;
      const businessId = randomUUID();
      await transaction(pool, async (db) => {
        await db.query(
          "INSERT INTO business(id,name,llm_provider,llm_model,llm_monthly_cap_usd) VALUES($1,$2,$3,$4,$5)",
          [
            businessId,
            body.businessName,
            c.LLM_PROVIDER,
            c.LLM_MODEL,
            c.LLM_MONTHLY_CAP_USD,
          ],
        );
        await db.query(
          "INSERT INTO membership(id,business_id,user_id,role,channel_scope) VALUES($1,$2,$3,'owner',ARRAY['*'])",
          [randomUUID(), businessId, newUserId],
        );
        await db.query("INSERT INTO user_preference(user_id) VALUES($1)", [
          newUserId,
        ]);
        await db.query(
          "INSERT INTO channel(id,business_id,platform,display_name) VALUES($1,$2,'tiktok','TikTok')",
          [randomUUID(), businessId],
        );
        await audit(db, {
          businessId,
          actorId: newUserId,
          action: "owner.created",
          payload: { businessName: body.businessName },
        });
      });
      return forwardAuth(reply, response);
    } catch (e) {
      if (newUserId)
        await pool.query(
          'DELETE FROM "user" WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM membership WHERE user_id=$1)',
          [newUserId],
        );
      throw e;
    } finally {
      await lock.query("SELECT pg_advisory_unlock(781210)");
      lock.release();
    }
  });
  app.post("/api/auth/*", async (req, reply) => {
    const path = req.url.split("?")[0].slice("/api/auth".length);
    if (!authPaths.has(path)) throw new AppError(404, "NOT_FOUND");
    await limited(`auth:${req.ip}`, 60);
    const body = z.record(z.string(), z.unknown()).parse(req.body ?? {});
    if (path === "/sign-in/email")
      await limited(
        `email:${String(body.email ?? "")
          .trim()
          .toLowerCase()}`,
        10,
      );
    if (body.trustDevice === true)
      throw new AppError(400, "TRUSTED_DEVICE_DISABLED");
    const response = await auth.handler(
      new Request(`${c.PUBLIC_URL}/api/auth${path}`, {
        method: "POST",
        headers: fromNodeHeaders(req.headers),
        body: JSON.stringify(body),
      }),
    );
    if (
      response.ok &&
      ["/two-factor/verify-totp", "/two-factor/verify-backup-code"].includes(
        path,
      )
    ) {
      const s = await auth.api.getSession({
        headers: sessionHeaders(req, response),
        query: { disableCookieCache: true },
      });
      if (s?.user.twoFactorEnabled) {
        await transaction(pool, async (db) => {
          const member = await db.query(
            "SELECT business_id FROM membership WHERE user_id=$1 AND revoked_at IS NULL",
            [s.user.id],
          );
          if (!member.rowCount) throw new AppError(403, "MEMBERSHIP_REVOKED");
          await db.query(
            "INSERT INTO mfa_session(session_id) VALUES($1) ON CONFLICT(session_id) DO UPDATE SET verified_at=now()",
            [s.session.id],
          );
          await audit(db, {
            businessId: member.rows[0].business_id,
            actorId: s.user.id,
            action: path.endsWith("backup-code")
              ? "auth.recovery_verified"
              : "auth.totp_verified",
          });
        });
      }
    }
    return forwardAuth(reply, response);
  });
  app.get("/api/session", async (req) => {
    const actor = await actorFor(auth, pool, req, true);
    return { actor };
  });
  app.get("/api/settings", async (req) => {
    const actor = await actorFor(auth, pool, req);
    const { rows } = await pool.query("SELECT * FROM business WHERE id=$1", [
      actor.businessId,
    ]);
    return {
      business: rows[0],
      mode: c.HELPA_MODE,
      providers: {
        openai: !!c.OPENAI_API_KEY,
        anthropic: !!c.ANTHROPIC_API_KEY,
      },
      smsProvider: "twilio",
      llmExecutionAvailable: true,
    };
  });
  app.patch("/api/settings", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "settings.write");
    const b = z
      .object({
        version: z.number().int(),
        name: z.string().trim().min(1).max(100),
        autoRepliesPaused: z.boolean(),
        postsRequireApproval: z.boolean(),
        llmProvider: z.enum(["openai", "anthropic"]),
        llmModel: z.string().trim().max(100),
        llmMonthlyCapUsd: z
          .number()
          .min(0)
          .max(100000)
          .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8),
      })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      const result = await db.query(
        `UPDATE business SET name=$1,auto_replies_paused=$2,posts_require_approval=$3,llm_provider=$4,llm_model=$5,llm_monthly_cap_usd=$6,settings_version=settings_version+1 WHERE id=$7 AND settings_version=$8 RETURNING id`,
        [
          b.name,
          b.autoRepliesPaused,
          b.postsRequireApproval,
          b.llmProvider,
          b.llmModel,
          b.llmMonthlyCapUsd,
          actor.businessId,
          b.version,
        ],
      );
      if (!result.rowCount) throw new AppError(409, "SETTINGS_CHANGED");
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "settings.updated",
        payload: b,
      });
    });
    return { ok: true };
  });
  app.patch("/api/preferences", async (req) => {
    const actor = await actorFor(auth, pool, req);
    const b = z
      .object({
        locale: z.enum(["vi", "en"]),
        timezone: z.enum(["Asia/Ho_Chi_Minh", "America/Los_Angeles", "UTC"]),
      })
      .strict()
      .parse(req.body);
    await pool.query(
      "INSERT INTO user_preference(user_id,locale,timezone) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET locale=excluded.locale,timezone=excluded.timezone",
      [actor.userId, b.locale, b.timezone],
    );
    return { ok: true };
  });
  app.get("/api/channels", async (req) => {
    const actor = await actorFor(auth, pool, req);
    const { rows } = await pool.query(
      `SELECT ${channelSelect} FROM channel WHERE business_id=$1 AND ($2::boolean OR platform=ANY($3::text[])) ORDER BY platform`,
      [actor.businessId, actor.channelScope.includes("*"), actor.channelScope],
    );
    return {
      channels: rows,
      facebookConfigured: !!c.META_APP_ID && !!c.META_APP_SECRET,
      mode: c.HELPA_MODE,
    };
  });
  app.post("/api/channels/facebook/start", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "channels.connect", "facebook");
    if (!c.META_APP_ID || !c.META_APP_SECRET)
      throw new AppError(409, "META_NOT_CONFIGURED");
    const state = randomBytes(32).toString("hex");
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO oauth_state(state_hash,business_id,user_id,session_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
        [hash(state), actor.businessId, actor.userId, actor.sessionId],
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "channel.oauth_started",
        payload: { platform: "facebook" },
      });
    });
    return { url: facebook.authorizationUrl(state) };
  });
  app.get("/api/channels/facebook/callback", async (req, reply) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "channels.connect", "facebook");
    const b = z
      .object({
        state: z.string().min(1).max(200),
        code: z.string().max(4000).optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    const state = await pool.query(
      "DELETE FROM oauth_state WHERE state_hash=$1 AND business_id=$2 AND user_id=$3 AND session_id=$4 AND expires_at>now() AND provider='facebook' RETURNING state_hash",
      [hash(b.state), actor.businessId, actor.userId, actor.sessionId],
    );
    if (!state.rowCount) throw new AppError(400, "OAUTH_STATE_INVALID");
    if (b.error || !b.code)
      return reply.redirect("/?page=channels&connection=cancelled");
    try {
      const pages = await facebook.discover(b.code);
      const id = randomUUID();
      await transaction(pool, async (db) => {
        await db.query("DELETE FROM oauth_selection WHERE session_id=$1", [
          actor.sessionId,
        ]);
        await db.query(
          "INSERT INTO oauth_selection(id,business_id,user_id,session_id,pages_encrypted,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
          [
            id,
            actor.businessId,
            actor.userId,
            actor.sessionId,
            JSON.stringify(
              encrypt(pages, `${actor.businessId}:selection:${id}`, c),
            ),
          ],
        );
        await audit(db, {
          businessId: actor.businessId,
          actorId: actor.userId,
          action: "channel.pages_discovered",
          payload: { count: pages.length },
        });
      });
      return reply.redirect("/?page=channels&connection=select");
    } catch (e) {
      await audit(pool, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "channel.oauth_failed",
        payload: {
          reason: e instanceof AppError ? e.code : "META_REQUEST_FAILED",
        },
      });
      return reply.redirect("/?page=channels&connection=failed");
    }
  });
  app.get("/api/channels/facebook/pending", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "channels.connect", "facebook");
    const r = await pool.query(
      "SELECT id,pages_encrypted FROM oauth_selection WHERE session_id=$1 AND user_id=$2 AND business_id=$3 AND expires_at>now()",
      [actor.sessionId, actor.userId, actor.businessId],
    );
    if (!r.rowCount) return { selection: null, pages: [] };
    const pages = decrypt<FacebookPage[]>(
      r.rows[0].pages_encrypted,
      `${actor.businessId}:selection:${r.rows[0].id}`,
      c,
    );
    return {
      selection: r.rows[0].id,
      pages: pages.map(({ accessToken, userAccessToken, ...p }) => p),
    };
  });
  app.post("/api/channels/facebook/select", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "channels.connect", "facebook");
    const b = z
      .object({
        selection: z.string().uuid(),
        pageId: z.string().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        actor.businessId,
      ]);
      const r = await db.query(
        "DELETE FROM oauth_selection WHERE id=$1 AND business_id=$2 AND user_id=$3 AND session_id=$4 AND expires_at>now() RETURNING pages_encrypted",
        [b.selection, actor.businessId, actor.userId, actor.sessionId],
      );
      if (!r.rowCount) throw new AppError(400, "OAUTH_SELECTION_EXPIRED");
      const page = decrypt<FacebookPage[]>(
        r.rows[0].pages_encrypted,
        `${actor.businessId}:selection:${b.selection}`,
        c,
      ).find((p) => p.id === b.pageId);
      if (!page) throw new AppError(400, "PAGE_NOT_FOUND");
      const existing = await db.query(
        "SELECT id FROM channel WHERE business_id=$1 AND platform='facebook' AND external_id=$2 FOR UPDATE",
        [actor.businessId, page.id],
      );
      const id = existing.rows[0]?.id ?? randomUUID();
      const encrypted = encrypt(
        {
          accessToken: page.accessToken,
          userAccessToken: page.userAccessToken,
        },
        `${actor.businessId}:channel:${id}`,
        c,
      );
      await db.query(
        `INSERT INTO channel(id,business_id,platform,external_id,display_name,mode,status,credentials_encrypted,token_expires_at,token_expiry_kind,granted_scopes,capabilities,connected_at)
        VALUES($1,$2,'facebook',$3,$4,'dry_run','connected',$5,$6,$7,$8,$9,now())
        ON CONFLICT(business_id,platform,external_id) DO UPDATE SET display_name=excluded.display_name,mode='dry_run',status='connected',credentials_encrypted=excluded.credentials_encrypted,token_expires_at=excluded.token_expires_at,token_expiry_kind=excluded.token_expiry_kind,granted_scopes=excluded.granted_scopes,capabilities=excluded.capabilities,connected_at=now(),disconnected_at=NULL`,
        [
          id,
          actor.businessId,
          page.id,
          page.name,
          JSON.stringify(encrypted),
          page.expiresAt,
          page.expiryKind,
          page.scopes,
          JSON.stringify({
            connection: "verified",
            publish: page.scopes.includes("pages_manage_posts")
              ? "available"
              : "permission_missing",
            inbox: "unavailable_phase_2",
            tasks: page.tasks,
          }),
        ],
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        channelId: id,
        action: "channel.connected",
        payload: {
          platform: "facebook",
          pageId: page.id,
          name: page.name,
          scopes: page.scopes,
          expiryKind: page.expiryKind,
        },
      });
    });
    return { ok: true };
  });
  app.post("/api/channels/:id/disconnect", async (req) => {
    const actor = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await transaction(pool, async (db) => {
      const r = await db.query(
        "SELECT platform FROM channel WHERE id=$1 AND business_id=$2 FOR UPDATE",
        [id, actor.businessId],
      );
      if (!r.rowCount) throw new AppError(404, "NOT_FOUND");
      requirePermission(actor, "channels.connect", r.rows[0].platform);
      await db.query(
        "UPDATE channel SET credentials_encrypted=NULL,status='disconnected',mode='manual',disconnected_at=now(),granted_scopes='{}',capabilities='{}',token_expires_at=NULL,token_expiry_kind='unknown' WHERE id=$1 AND business_id=$2",
        [id, actor.businessId],
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        channelId: id,
        action: "channel.disconnected",
      });
    });
    return { ok: true };
  });
  await auditRoutes(app, pool, auth);
  app.get("/api/system", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "system.read");
    const [heartbeat, jobs, ops] = await Promise.all([
      pool.query(
        "SELECT last_seen_at,details,last_seen_at>now()-interval '45 seconds' AS healthy FROM system_heartbeat WHERE name='worker'",
      ),
      pool.query(
        "SELECT state::text,count(*)::integer AS count FROM pgboss.job WHERE data->>'businessId'=$1 GROUP BY state",
        [actor.businessId],
      ),
      pool.query(
        "SELECT o.id,o.operation_key,o.payload,o.mode,o.outcome,o.created_at FROM outbound_operation o LEFT JOIN channel c ON c.id=o.channel_id WHERE o.business_id=$1 AND ($2 OR c.platform=ANY($3::text[]) OR o.channel_id IS NULL) ORDER BY o.created_at DESC LIMIT 10",
        [
          actor.businessId,
          actor.channelScope.includes("*"),
          actor.channelScope,
        ],
      ),
    ]);
    return {
      database: "healthy",
      worker: heartbeat.rows[0] ?? null,
      jobs: jobs.rows,
      operations: ops.rows,
      mode: c.HELPA_MODE,
      webhooks: {
        status: "ready",
        recovery:
          actor.role === "owner"
            ? (
                await pool.query(
                  "SELECT id,provider,status,attempts,error,received_at,last_attempt_at,next_attempt_at FROM webhook_event WHERE status='failed' OR (status='pending' AND attempts>0) ORDER BY received_at LIMIT 50",
                )
              ).rows
            : [],
        channels: (
          await pool.query(
            "SELECT c.id,c.display_name,max(m.received_at) AS last_event FROM channel c LEFT JOIN conversation v ON v.channel_id=c.id AND v.kind<>'manual' LEFT JOIN message m ON m.conversation_id=v.id WHERE c.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) GROUP BY c.id",
            [
              actor.businessId,
              actor.channelScope.includes("*"),
              actor.channelScope,
            ],
          )
        ).rows,
        failures:
          actor.role === "owner"
            ? Number(
                (
                  await pool.query(
                    "SELECT count(*) FROM webhook_event WHERE status='failed'",
                  )
                ).rows[0].count,
              )
            : null,
      },
      knowledge: {
        status: "ready",
        lastSync: (
          await pool.query(
            "SELECT max(last_sync_at) AS last FROM knowledge_source WHERE business_id=$1",
            [actor.businessId],
          )
        ).rows[0].last,
      },
      llm:
        actor.role === "owner"
          ? (
              await pool.query(
                "SELECT budget_month,sum(reserved_microusd)::text AS reserved_microusd,sum(charged_microusd)::text AS charged_microusd,count(*)::int AS calls FROM llm_call WHERE business_id=$1 GROUP BY budget_month ORDER BY budget_month DESC LIMIT 3",
                [actor.businessId],
              )
            ).rows
          : [],
      notifications:
        actor.role === "owner"
          ? (
              await pool.query(
                "SELECT transport,status,count(*)::int AS count FROM notification WHERE business_id=$1 GROUP BY transport,status",
                [actor.businessId],
              )
            ).rows
          : [],
    };
  });
  app.post("/api/system/webhooks/:id/retry", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "settings.write");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return transaction(pool, async (db) => {
      const event = (
        await db.query(
          "SELECT id,attempts,status FROM webhook_event WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!event) throw new AppError(404, "NOT_FOUND");
      if (event.status !== "failed")
        throw new AppError(409, "WEBHOOK_NOT_FAILED");
      await db.query(
        "UPDATE webhook_event SET status='pending',attempts=0,error=NULL,next_attempt_at=now() WHERE id=$1",
        [id],
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "webhook.retry_requested",
        payload: { eventId: id, previousAttempts: event.attempts },
      });
      return { ok: true };
    });
  });
  app.post("/api/system/dry-run-probe", async (req) => {
    const actor = await actorFor(auth, pool, req);
    requirePermission(actor, "settings.write");
    if (c.HELPA_MODE !== "dry_run") throw new AppError(409, "DRY_RUN_REQUIRED");
    const operationKey = randomUUID();
    const payload = {
      kind: "foundation_diagnostic",
      message: "Helpa dry-run check",
      businessTimezone: "Asia/Ho_Chi_Minh",
    };
    await transaction(pool, async (db) => {
      await boss.send(
        probeQueue,
        {
          businessId: actor.businessId,
          actorId: actor.userId,
          operationKey,
          payload,
        },
        {
          db: { executeSql: (text, values) => db.query(text, values) },
          singletonKey: operationKey,
        },
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "system.probe_queued",
        payload: { operationKey, exactPayload: payload },
      });
    });
    return { operationKey };
  });
  await publisherRoutes(app, pool, auth, c, boss);
  await tiktokRoutes(app, pool, auth, c);
  await knowledgeRoutes(app, pool, auth, c);
  await teamRoutes(app, pool, auth, c, { forwardAuth, sessionHeaders });
  await metricsRoutes(app, pool, auth, c);
  await advisorRoutes(app, pool, auth, c);
  await inboxRoutes(app, pool, auth, c);
  if (
    options.serveWeb !== false &&
    existsSync(resolve("dist/web/index.html"))
  ) {
    await app.register(fastifyStatic, { root: resolve("dist/web") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api")
        ? reply.code(404).send({ error: "NOT_FOUND" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    if (!options.boss) await boss.stop();
    if (!options.pool) await pool.end();
  });
  return { app, pool, boss, auth };
}
