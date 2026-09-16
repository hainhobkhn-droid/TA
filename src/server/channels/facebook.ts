import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});
const inspectionSchema = z.object({
  data: z.object({
    app_id: z.union([z.string(), z.number()]),
    is_valid: z.boolean(),
    expires_at: z.number().optional(),
    scopes: z.array(z.string()).default([]),
    user_id: z.string().optional(),
  }),
});
const pagesSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      access_token: z.string(),
      tasks: z.array(z.string()).default([]),
    }),
  ),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().optional() }).optional(),
    })
    .optional(),
});
export type FacebookPage = {
  id: string;
  name: string;
  accessToken: string;
  userAccessToken?: string;
  tasks: string[];
  scopes: string[];
  expiresAt: string | null;
  expiryKind: "unknown" | "no_scheduled_expiry" | "known";
};
export type FacebookConnection = {
  authorizationUrl: (state: string) => string;
  discover: (code: string) => Promise<FacebookPage[]>;
};

// Scopes verified against the Pages Posts, Photos, Reels and Comments references.
export function facebookConnection(
  c: Config,
  fetcher: typeof fetch = fetch,
): FacebookConnection {
  const callback = `${c.PUBLIC_URL}/api/channels/facebook/callback`;
  const base = `https://graph.facebook.com/${c.META_GRAPH_VERSION}/`;
  async function graph(
    path: string,
    params: Record<string, string>,
    token?: string,
  ): Promise<unknown> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    if (token)
      url.searchParams.set(
        "appsecret_proof",
        createHmac("sha256", c.META_APP_SECRET).update(token).digest("hex"),
      );
    try {
      const r = await fetcher(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const body = (await r.json()) as { error?: { code?: number } };
      if (!r.ok || body.error)
        throw new AppError(
          502,
          body.error?.code === 190
            ? "META_RECONNECT_REQUIRED"
            : "META_REQUEST_FAILED",
        );
      return body;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, "META_REQUEST_FAILED");
    }
  }
  const inspect = async (token: string) => {
    const result = inspectionSchema.parse(
      await graph(
        "debug_token",
        { input_token: token },
        `${c.META_APP_ID}|${c.META_APP_SECRET}`,
      ),
    ).data;
    if (!result.is_valid || String(result.app_id) !== c.META_APP_ID)
      throw new AppError(400, "META_TOKEN_INVALID");
    if (result.expires_at && result.expires_at <= Date.now() / 1000)
      throw new AppError(400, "META_TOKEN_EXPIRED");
    return result;
  };
  return {
    authorizationUrl(state) {
      const url = new URL(
        `https://www.facebook.com/${c.META_GRAPH_VERSION}/dialog/oauth`,
      );
      url.search = new URLSearchParams({
        client_id: c.META_APP_ID,
        redirect_uri: callback,
        state,
        response_type: "code",
        scope:
          "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,pages_messaging,pages_manage_metadata" +
          (c.AUDIENCE_METRICS_ENABLED ? ",read_insights" : ""),
      }).toString();
      return url.toString();
    },
    async discover(code) {
      const short = tokenSchema.parse(
        await graph("oauth/access_token", {
          client_id: c.META_APP_ID,
          client_secret: c.META_APP_SECRET,
          redirect_uri: callback,
          code,
        }),
      );
      const long = tokenSchema.parse(
        await graph("oauth/access_token", {
          client_id: c.META_APP_ID,
          client_secret: c.META_APP_SECRET,
          grant_type: "fb_exchange_token",
          fb_exchange_token: short.access_token,
        }),
      );
      const info = await inspect(long.access_token);
      if (!info.scopes.includes("pages_show_list"))
        throw new AppError(400, "META_PERMISSION_MISSING");
      const pages: FacebookPage[] = [];
      let after: string | undefined;
      for (let batch = 0; batch < 20; batch++) {
        const result = pagesSchema.parse(
          await graph("me/accounts", after ? { after } : {}, long.access_token),
        );
        for (const p of result.data) {
          const details = await inspect(p.access_token);
          pages.push({
            id: p.id,
            name: p.name,
            accessToken: p.access_token,
            userAccessToken: long.access_token,
            tasks: p.tasks,
            scopes: details.scopes,
            expiresAt: details.expires_at
              ? new Date(details.expires_at * 1000).toISOString()
              : null,
            expiryKind:
              details.expires_at === 0
                ? "no_scheduled_expiry"
                : details.expires_at
                  ? "known"
                  : "unknown",
          });
        }
        if (!result.paging?.next) return pages;
        const next = result.paging.cursors?.after;
        if (!next || next === after)
          throw new AppError(502, "META_PAGINATION_INVALID");
        after = next;
      }
      throw new AppError(502, "META_TOO_MANY_PAGES");
    },
  };
}
