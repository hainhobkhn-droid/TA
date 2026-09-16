import { z } from "zod";
import {
  createHash,
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { Config } from "../config.js";
import type { PgPool } from "../db/index.js";
import { transaction } from "../db/index.js";
import { actorFor, requirePermission, type Auth } from "../auth/index.js";
import { encrypt, decrypt } from "./crypto.js";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mediaPath } from "../media/service.js";
import type { PublishingTransport, Step } from "./facebook-publisher.js";
export const tokenSchema = z.object({
  open_id: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
  expires_in: z.number().positive(),
  refresh_expires_in: z.number().positive(),
});
export async function tiktokCall(
  path: string,
  token: string,
  body: unknown = {},
  fetcher: typeof fetch = fetch,
) {
  try {
    const r = await fetcher(`https://open.tiktokapis.com/v2/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const d: any = await r.json();
    if (!r.ok || d.error?.code !== "ok")
      throw new AppError(
        502,
        d.error?.code === "access_token_invalid"
          ? "TIKTOK_RECONNECT_REQUIRED"
          : "TIKTOK_REQUEST_REJECTED",
      );
    return d.data;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
  }
}
export async function tiktokToken(
  c: Config,
  grant: Record<string, string>,
  fetcher: typeof fetch = fetch,
) {
  const r = await fetcher("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: c.TIKTOK_CLIENT_KEY,
      client_secret: c.TIKTOK_CLIENT_SECRET,
      ...grant,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new AppError(502, "TIKTOK_RECONNECT_REQUIRED");
  const parsed = tokenSchema.safeParse(await r.json());
  if (!parsed.success) throw new AppError(502, "TIKTOK_RECONNECT_REQUIRED");
  return parsed.data;
}
const signature = (c: Config, id: string, exp: number) =>
  createHmac("sha256", c.AUTH_SECRET)
    .update(`media-transfer:${id}:${exp}`)
    .digest("hex");
export function transferUrl(c: Config, id: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${c.PUBLIC_URL}/media-transfer/${id}?expires=${exp}&signature=${signature(c, id, exp)}`;
}
export function tiktokPublisher(
  c: Config,
  token: string,
  step: Step,
  fetcher: typeof fetch = fetch,
): PublishingTransport {
  return {
    async publish(p) {
      const t = p.tiktok;
      if (!t || t.mode === "manual")
        return {
          outcome: "needs_action",
          reason: "MANUAL_PUBLICATION_REQUIRED",
        };
      if (!t.consent || !t.musicRights)
        throw new AppError(409, "TIKTOK_EXPLICIT_CONSENT_REQUIRED");
      if (!c.TIKTOK_URL_OWNERSHIP_VERIFIED)
        throw new AppError(409, "TIKTOK_VERIFY_MEDIA_DOMAIN");
      if (
        t.mode === "direct" &&
        c.TIKTOK_DIRECT_POST_ELIGIBILITY !== "approved"
      )
        throw new AppError(409, "TIKTOK_ELIGIBILITY_UNVERIFIED");
      const source_info = {
        source: "PULL_FROM_URL",
        video_url: transferUrl(c, p.media[0].id),
      };
      let body: any = { source_info };
      if (t.mode === "direct") {
        const creator = await tiktokCall(
          "post/publish/creator_info/query/",
          token,
          {},
          fetcher,
        );
        if (!t.privacy || !creator.privacy_level_options?.includes(t.privacy))
          throw new AppError(409, "TIKTOK_PRIVACY_CHANGED");
        if (
          (p.media[0].metadata.duration ?? Infinity) >
          creator.max_video_post_duration_sec
        )
          throw new AppError(409, "TIKTOK_CREATOR_DURATION_LIMIT");
        if (
          (creator.comment_disabled && t.allowComment) ||
          (creator.duet_disabled && t.allowDuet) ||
          (creator.stitch_disabled && t.allowStitch)
        )
          throw new AppError(409, "TIKTOK_INTERACTION_CHANGED");
        if (t.paidPartnership && t.privacy === "SELF_ONLY")
          throw new AppError(409, "TIKTOK_BRANDED_PRIVACY");
        body = {
          source_info,
          post_info: {
            title: [p.caption, ...p.hashtags].join("\n"),
            privacy_level: t.privacy,
            disable_comment: !t.allowComment,
            disable_duet: !t.allowDuet,
            disable_stitch: !t.allowStitch,
            brand_organic_toggle: t.ownBrand,
            brand_content_toggle: t.paidPartnership,
            is_aigc: t.aiGenerated,
          },
        };
      }
      const path =
        t.mode === "direct"
          ? "post/publish/video/init/"
          : "post/publish/inbox/video/init/";
      const r = await step(
        "tiktok:init",
        { endpoint: "/v2/" + path, body },
        () => tiktokCall(path, token, body, fetcher),
      );
      if (!r.publish_id) throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
      // An accepted upload is never represented as a public post.
      return {
        outcome: "needs_action",
        platformId: r.publish_id,
        reason:
          t.mode === "inbox"
            ? "TIKTOK_FINISH_IN_APP"
            : "TIKTOK_PROCESSING_VERIFY_STATUS",
      };
    },
  };
}
export async function tiktokRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
  c: Config,
) {
  app.post("/api/channels/tiktok/start", async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "channels.connect", "tiktok");
    if (!c.TIKTOK_CLIENT_KEY || !c.TIKTOK_CLIENT_SECRET)
      throw new AppError(409, "TIKTOK_NOT_CONFIGURED");
    const state = randomBytes(32).toString("hex");
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO oauth_state(state_hash,business_id,user_id,session_id,expires_at,provider) VALUES($1,$2,$3,$4,now()+interval '10 minutes','tiktok')",
        [
          createHash("sha256").update(state).digest("hex"),
          a.businessId,
          a.userId,
          a.sessionId,
        ],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "channel.tiktok_oauth_started",
      });
    });
    return {
      url:
        "https://www.tiktok.com/v2/auth/authorize/?" +
        new URLSearchParams({
          client_key: c.TIKTOK_CLIENT_KEY,
          response_type: "code",
          scope:
            "video.publish,video.upload" +
            (c.AUDIENCE_METRICS_ENABLED ? ",video.list,user.info.stats" : ""),
          redirect_uri: c.PUBLIC_URL + "/api/channels/tiktok/callback",
          state,
        }),
    };
  });
  app.get("/api/channels/tiktok/callback", async (req, reply) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "channels.connect", "tiktok");
    const q = z
      .object({
        state: z.string().max(200),
        code: z.string().max(2000).optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    const state = await pool.query(
      "DELETE FROM oauth_state WHERE state_hash=$1 AND business_id=$2 AND user_id=$3 AND session_id=$4 AND expires_at>now() AND provider='tiktok' RETURNING *",
      [
        createHash("sha256").update(q.state).digest("hex"),
        a.businessId,
        a.userId,
        a.sessionId,
      ],
    );
    if (!state.rowCount) throw new AppError(400, "OAUTH_STATE_INVALID");
    if (q.error || !q.code)
      return reply.redirect("/?page=channels&tiktok=cancelled");
    try {
      const token = await tiktokToken(c, {
        code: q.code,
        grant_type: "authorization_code",
        redirect_uri: c.PUBLIC_URL + "/api/channels/tiktok/callback",
      });
      const scopes = token.scope.split(",");
      let creator: any = null;
      if (scopes.includes("video.publish"))
        creator = await tiktokCall(
          "post/publish/creator_info/query/",
          token.access_token,
        );
      await transaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `tiktok-connect:${a.businessId}`,
        ]);
        const old = (
          await db.query(
            "SELECT id FROM channel WHERE business_id=$1 AND platform='tiktok' AND (external_id=$2 OR external_id IS NULL) ORDER BY external_id NULLS LAST LIMIT 1 FOR UPDATE",
            [a.businessId, token.open_id],
          )
        ).rows[0];
        const id = old?.id ?? randomUUID();
        const enc = encrypt(
          {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            refreshExpiresAt: new Date(
              Date.now() + token.refresh_expires_in * 1000,
            ).toISOString(),
          },
          `${a.businessId}:channel:${id}`,
          c,
        );
        const capabilities = {
          publish: scopes.includes("video.publish")
            ? "granted"
            : "permission_missing",
          upload: scopes.includes("video.upload")
            ? "granted"
            : "permission_missing",
          eligibility: c.TIKTOK_DIRECT_POST_ELIGIBILITY,
        };
        if (old)
          await db.query(
            "UPDATE channel SET external_id=$3,display_name=$4,status='connected',mode='dry_run',credentials_encrypted=$5,token_expires_at=$6,token_expiry_kind='known',granted_scopes=$7,capabilities=$8,connected_at=now(),disconnected_at=NULL WHERE business_id=$1 AND id=$2",
            [
              a.businessId,
              id,
              token.open_id,
              creator?.creator_nickname ?? "TikTok",
              enc,
              new Date(Date.now() + token.expires_in * 1000),
              scopes,
              capabilities,
            ],
          );
        else
          await db.query(
            "INSERT INTO channel(id,business_id,platform,external_id,display_name,status,mode,credentials_encrypted,token_expires_at,token_expiry_kind,granted_scopes,capabilities,connected_at) VALUES($1,$2,'tiktok',$3,$4,'connected','dry_run',$5,$6,'known',$7,$8,now())",
            [
              id,
              a.businessId,
              token.open_id,
              creator?.creator_nickname ?? "TikTok",
              enc,
              new Date(Date.now() + token.expires_in * 1000),
              scopes,
              capabilities,
            ],
          );
        await audit(db, {
          businessId: a.businessId,
          actorId: a.userId,
          channelId: id,
          action: "channel.connected",
          payload: { platform: "tiktok", scopes, capabilities },
        });
      });
      return reply.redirect("/?page=channels&tiktok=connected");
    } catch {
      return reply.redirect("/?page=channels&tiktok=failed");
    }
  });
  app.get("/api/channels/:id/creator", async (req) => {
    const a = await actorFor(auth, pool, req);
    requirePermission(a, "posts.write", "tiktok");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ch = (
      await pool.query(
        "SELECT * FROM channel WHERE business_id=$1 AND id=$2 AND platform='tiktok'",
        [a.businessId, id],
      )
    ).rows[0];
    if (
      !ch?.credentials_encrypted ||
      !ch.granted_scopes.includes("video.publish")
    )
      throw new AppError(409, "TIKTOK_RECONNECT_REQUIRED");
    const token: any = decrypt(
      ch.credentials_encrypted,
      `${a.businessId}:channel:${id}`,
      c,
    );
    const creator = await tiktokCall(
      "post/publish/creator_info/query/",
      token.accessToken,
    );
    return {
      creator,
      eligibility: c.TIKTOK_DIRECT_POST_ELIGIBILITY,
      urlOwnershipVerified: c.TIKTOK_URL_OWNERSHIP_VERIFIED,
    };
  });
  app.get("/media-transfer/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z
      .object({
        expires: z.coerce.number().int(),
        signature: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(req.query);
    if (
      c.HELPA_MODE !== "live" ||
      q.expires < Date.now() / 1000 ||
      q.expires > Date.now() / 1000 + 3601 ||
      !timingSafeEqual(
        Buffer.from(q.signature),
        Buffer.from(signature(c, id, q.expires)),
      )
    )
      throw new AppError(403, "TRANSFER_EXPIRED");
    const m = (
      await pool.query(
        "SELECT * FROM media_asset WHERE id=$1 AND status='ready'",
        [id],
      )
    ).rows[0];
    if (!m) throw new AppError(404, "NOT_FOUND");
    reply.header("cache-control", "no-store");
    return reply
      .type(m.mime)
      .send(createReadStream(mediaPath(c, m.storage_key)));
  });
}
