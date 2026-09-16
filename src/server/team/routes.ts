import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import {
  actorFor,
  requirePermission,
  type Auth,
  type Actor,
} from "../auth/index.js";
import { transaction, type PgPool } from "../db/index.js";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
import { acceptInvitation, eligible, hashIdentity } from "./access.js";
const grant = z.object({
  role: z.enum(["manager", "editor", "agent", "viewer"]),
  channelScope: z
    .array(z.enum(["*", "facebook", "tiktok"]))
    .min(1)
    .max(2),
  deniedPermissions: z
    .array(
      z.enum([
        "posts.write",
        "replies.write",
        "approvals.write",
        "audit.read",
        "system.read",
      ]),
    )
    .max(5)
    .default([]),
});
export async function teamRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
  c: Config,
  helpers: {
    forwardAuth: (reply: FastifyReply, response: Response) => Promise<any>;
    sessionHeaders: (req: FastifyRequest, response: Response) => Headers;
  },
) {
  async function limit(key: string, max: number) {
    const r = await pool.query(
      "INSERT INTO login_limit(key,attempts,resets_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limit.resets_at<now() THEN 1 ELSE login_limit.attempts+1 END,resets_at=CASE WHEN login_limit.resets_at<now() THEN now()+interval '15 minutes' ELSE login_limit.resets_at END RETURNING attempts",
      [hashIdentity(key)],
    );
    if (r.rows[0].attempts > max) throw new AppError(429, "RATE_LIMITED");
  }
  async function manage(req: any) {
    const a = await actorFor(auth, pool, req);
    if (!["owner", "manager"].includes(a.role))
      throw new AppError(403, "FORBIDDEN");
    return a;
  }
  function checkGrant(a: Actor, b: z.infer<typeof grant>) {
    if (
      a.role === "manager" &&
      (b.role === "manager" ||
        (!a.channelScope.includes("*") &&
          b.channelScope.some((s) => !a.channelScope.includes(s))))
    )
      throw new AppError(403, "GRANT_EXCEEDS_AUTHORITY");
    if (b.channelScope.includes("*") && b.channelScope.length !== 1)
      throw new AppError(400, "INVALID_SCOPE");
  }
  app.get("/api/team", async (req) => {
    const a = await manage(req);
    const all = a.role === "owner";
    return {
      members: (
        await pool.query(
          'SELECT m.*,u.name,u.email,u."phoneNumber",u."twoFactorEnabled" FROM membership m JOIN "user" u ON u.id=m.user_id WHERE m.business_id=$1 AND ($2 OR m.channel_scope<@$3::text[]) ORDER BY m.created_at',
          [a.businessId, all || a.channelScope.includes("*"), a.channelScope],
        )
      ).rows,
      invitations: (
        await pool.query(
          "SELECT * FROM invitation WHERE business_id=$1 AND ($2 OR invited_by=$3) ORDER BY created_at DESC LIMIT 100",
          [a.businessId, all, a.userId],
        )
      ).rows,
      duty: (
        await pool.query(
          "SELECT * FROM duty_slot WHERE business_id=$1 AND ($2 OR platform=ANY($3::text[])) ORDER BY weekday,start_hour",
          [a.businessId, a.channelScope.includes("*"), a.channelScope],
        )
      ).rows,
    };
  });
  app.post("/api/team/invitations", async (req) => {
    const a = await manage(req);
    const b = grant
      .extend({
        name: z.string().trim().min(1).max(100),
        kind: z.enum(["phone", "email"]),
        identity: z.string().trim().min(3).max(254),
      })
      .strict()
      .parse(req.body);
    checkGrant(a, b);
    const identity =
      b.kind === "email"
        ? z.string().email().parse(b.identity).toLowerCase()
        : z
            .string()
            .regex(/^\+84[35789]\d{8}$/)
            .parse(b.identity);
    if (identity.endsWith("@phone.invalid"))
      throw new AppError(400, "INVALID_IDENTITY");
    const id = randomUUID();
    const userId = await transaction(pool, async (db) => {
      await db.query("SELECT id FROM business WHERE id=$1 FOR UPDATE", [
        a.businessId,
      ]);
      let user = (
        await db.query(
          `SELECT u.id,m.role,m.revoked_at FROM "user" u LEFT JOIN membership m ON m.user_id=u.id WHERE ${b.kind === "phone" ? 'u."phoneNumber"' : "lower(u.email)"}=$1`,
          [identity],
        )
      ).rows[0];
      if (user?.role && !user.revoked_at)
        throw new AppError(409, "ALREADY_A_MEMBER");
      if (!user) {
        user = { id: randomUUID() };
        await db.query(
          'INSERT INTO "user"(id,name,email,"phoneNumber") VALUES($1,$2,$3,$4)',
          [
            user.id,
            b.name,
            b.kind === "email"
              ? identity
              : `${hashIdentity(identity)}@phone.invalid`,
            b.kind === "phone" ? identity : null,
          ],
        );
      }
      await db.query(
        "UPDATE invitation SET status='superseded' WHERE user_id=$1 AND status='pending'",
        [user.id],
      );
      await db.query(
        "INSERT INTO invitation(id,business_id,user_id,invited_by,identity,kind,role,channel_scope,denied_permissions,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '7 days')",
        [
          id,
          a.businessId,
          user.id,
          a.userId,
          identity,
          b.kind,
          b.role,
          b.channelScope,
          b.deniedPermissions,
        ],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "invitation.created",
        payload: {
          id,
          userId: user.id,
          kind: b.kind,
          role: b.role,
          channelScope: b.channelScope,
          deniedPermissions: b.deniedPermissions,
        },
      });
      return user.id;
    });
    // Dispatch is separate from the durable invite: delivery failure leaves a reviewable pending invite.
    let delivery = "requested";
    try {
      if (b.kind === "email")
        await auth.api.signInMagicLink({
          headers: fromNodeHeaders(req.headers),
          body: { email: identity, callbackURL: "/" },
        });
      else
        await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: identity } });
    } catch {
      delivery = "not_delivered";
    }
    return { id, userId, delivery, loginUrl: c.PUBLIC_URL };
  });
  app.post("/api/team/invitations/:id/revoke", async (req) => {
    const a = await manage(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await transaction(pool, async (db) => {
      const r = await db.query(
        "UPDATE invitation SET status='revoked' WHERE id=$1 AND business_id=$2 AND status='pending' AND ($3 OR invited_by=$4) RETURNING id",
        [id, a.businessId, a.role === "owner", a.userId],
      );
      if (!r.rowCount) throw new AppError(404, "NOT_FOUND");
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "invitation.revoked",
        payload: { id },
      });
    });
    return { ok: true };
  });
  app.patch("/api/team/members/:id", async (req) => {
    const a = await manage(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = grant
      .extend({ revoke: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    checkGrant(a, b);
    await transaction(pool, async (db) => {
      const old = (
        await db.query(
          "SELECT * FROM membership WHERE user_id=$1 AND business_id=$2 FOR UPDATE",
          [id, a.businessId],
        )
      ).rows[0];
      if (!old) throw new AppError(404, "NOT_FOUND");
      if (
        old.role === "owner" ||
        (a.role === "manager" &&
          (old.role === "manager" ||
            (!a.channelScope.includes("*") &&
              old.channel_scope.some(
                (s: string) => !a.channelScope.includes(s),
              ))))
      )
        throw new AppError(403, "MEMBER_PROTECTED");
      await db.query(
        "UPDATE membership SET role=$3,channel_scope=$4,denied_permissions=$5,revoked_at=CASE WHEN $6 THEN now() ELSE revoked_at END WHERE user_id=$1 AND business_id=$2",
        [
          id,
          a.businessId,
          b.role,
          b.channelScope,
          b.deniedPermissions,
          b.revoke,
        ],
      );
      await db.query('DELETE FROM session WHERE "userId"=$1', [id]);
      await db.query(
        "UPDATE invitation SET status='revoked' WHERE user_id=$1 AND status='pending'",
        [id],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: b.revoke ? "membership.revoked" : "membership.updated",
        payload: { userId: id, ...b },
      });
    });
    return { ok: true };
  });
  app.post("/api/team/duty", async (req) => {
    const a = await manage(req);
    const b = z
      .object({
        slots: z
          .array(
            z
              .object({
                userId: z.string(),
                platform: z.enum(["facebook", "tiktok"]),
                weekday: z.number().int().min(0).max(6),
                startHour: z.number().int().min(0).max(23),
                endHour: z.number().int().min(1).max(24),
              })
              .refine((s) => s.endHour > s.startHour),
          )
          .max(200),
      })
      .strict()
      .parse(req.body);
    await transaction(pool, async (db) => {
      await db.query("SELECT id FROM business WHERE id=$1 FOR UPDATE", [
        a.businessId,
      ]);
      for (const s of b.slots) {
        if (
          !a.channelScope.includes("*") &&
          !a.channelScope.includes(s.platform)
        )
          throw new AppError(403, "FORBIDDEN");
        const m = (
          await db.query(
            "SELECT * FROM membership WHERE user_id=$1 AND business_id=$2 AND revoked_at IS NULL",
            [s.userId, a.businessId],
          )
        ).rows[0];
        if (
          !m ||
          !["owner", "manager", "agent"].includes(m.role) ||
          (!m.channel_scope.includes("*") &&
            !m.channel_scope.includes(s.platform)) ||
          m.denied_permissions.includes("approvals.write") ||
          m.denied_permissions.includes("replies.write")
        )
          throw new AppError(400, "DUTY_MEMBER_NOT_ELIGIBLE");
        if (
          b.slots.some(
            (o) =>
              o !== s &&
              o.platform === s.platform &&
              o.weekday === s.weekday &&
              o.startHour < s.endHour &&
              o.endHour > s.startHour,
          )
        )
          throw new AppError(400, "OVERLAPPING_DUTY_SLOTS");
      }
      await db.query(
        "DELETE FROM duty_slot WHERE business_id=$1 AND ($2 OR platform=ANY($3::text[]))",
        [a.businessId, a.channelScope.includes("*"), a.channelScope],
      );
      for (const s of b.slots)
        await db.query(
          "INSERT INTO duty_slot(id,business_id,user_id,platform,weekday,start_hour,end_hour) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            a.businessId,
            s.userId,
            s.platform,
            s.weekday,
            s.startHour,
            s.endHour,
          ],
        );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "duty.updated",
        payload: b,
      });
    });
    return { ok: true };
  });
  app.get("/api/sessions", async (req) => {
    const a = await actorFor(auth, pool, req);
    return {
      sessions: (
        await pool.query(
          'SELECT id,"createdAt","expiresAt","ipAddress","userAgent" FROM session WHERE "userId"=$1 ORDER BY "createdAt" DESC',
          [a.userId],
        )
      ).rows,
      current: a.sessionId,
    };
  });
  app.post("/api/sessions/:id/revoke", async (req) => {
    const a = await actorFor(auth, pool, req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await transaction(pool, async (db) => {
      await db.query('DELETE FROM session WHERE id=$1 AND "userId"=$2', [
        id,
        a.userId,
      ]);
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "session.revoked",
        payload: { sessionId: id },
      });
    });
    return { ok: true };
  });
  app.post("/api/access/email", async (req) => {
    await limit(`access-ip:${req.ip}`, 30);
    const { email } = z
      .object({ email: z.string().email().max(254) })
      .strict()
      .parse(req.body);
    await limit("email-link:" + email.toLowerCase(), 5);
    if (
      !email.endsWith("@phone.invalid") &&
      (await eligible(pool, email.toLowerCase(), "email"))
    )
      await auth.api.signInMagicLink({
        headers: fromNodeHeaders(req.headers),
        body: { email: email.toLowerCase(), callbackURL: "/" },
      });
    return { ok: true };
  });
  app.post("/api/access/phone", async (req) => {
    await limit(`access-ip:${req.ip}`, 30);
    const { phone } = z
      .object({ phone: z.string().regex(/^\+84[35789]\d{8}$/) })
      .strict()
      .parse(req.body);
    await limit("sms:" + phone, 5);
    if (await eligible(pool, phone, "phone"))
      await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: phone } });
    return { ok: true };
  });
  for (const method of ["email", "phone"] as const)
    app.post("/api/access/verify-" + method, async (req, reply) => {
      await limit(`access-verify:${req.ip}`, 30);
      const body =
        method === "email"
          ? z
              .object({ token: z.string().min(20).max(500) })
              .strict()
              .parse(req.body)
          : z
              .object({
                phone: z.string().regex(/^\+84[35789]\d{8}$/),
                code: z.string().regex(/^\d{6}$/),
              })
              .strict()
              .parse(req.body);
      const response =
        method === "email"
          ? await auth.api.magicLinkVerify({
              query: { token: (body as any).token },
              headers: fromNodeHeaders(req.headers),
              asResponse: true,
            })
          : await auth.api.verifyPhoneNumber({
              body: {
                phoneNumber: (body as any).phone,
                code: (body as any).code,
                disableSession: false,
                updatePhoneNumber: false,
              },
              headers: fromNodeHeaders(req.headers),
              asResponse: true,
            });
      if (response.ok) {
        const session = await auth.api.getSession({
          headers: helpers.sessionHeaders(req, response),
          query: { disableCookieCache: true },
        });
        if (session) {
          await acceptInvitation(pool, session.user.id);
          const m = (
            await pool.query(
              "SELECT business_id FROM membership WHERE user_id=$1 AND revoked_at IS NULL",
              [session.user.id],
            )
          ).rows[0];
          if (!m) {
            await pool.query("DELETE FROM session WHERE id=$1", [
              session.session.id,
            ]);
            throw new AppError(403, "INVITATION_REQUIRED");
          }
          await audit(pool, {
            businessId: m.business_id,
            actorId: session.user.id,
            action: "session.passwordless_login",
            payload: {
              method,
              mfaStillRequired: !!session.user.twoFactorEnabled,
            },
          });
        }
      }
      return helpers.forwardAuth(reply, response);
    });
  app.post("/api/access/password", async (req, reply) => {
    const a = await actorFor(auth, pool, req);
    const { password } = z
      .object({ password: z.string().min(12).max(128) })
      .strict()
      .parse(req.body);
    const response = await auth.api.setPassword({
      body: { newPassword: password },
      headers: fromNodeHeaders(req.headers),
      asResponse: true,
    });
    if (response.ok)
      await audit(pool, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "password.created",
      });
    return helpers.forwardAuth(reply, response);
  });
}
