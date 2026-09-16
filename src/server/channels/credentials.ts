import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { tiktokToken } from "./tiktok.js";
export async function refreshChannelCredentials(
  c: Config,
  ch: any,
  creds: any,
  fetcher: typeof fetch = fetch,
) {
  let next = creds,
    expires = ch.token_expires_at,
    expiryKind = ch.token_expiry_kind,
    scopes = ch.granted_scopes;
  if (ch.platform === "tiktok") {
    if (!c.TIKTOK_CLIENT_KEY || !c.TIKTOK_CLIENT_SECRET) return null;
    if (expires && Date.parse(expires) < Date.now() + 12 * 3600000) {
      if (
        !creds.refreshToken ||
        Date.parse(creds.refreshExpiresAt) <= Date.now()
      )
        throw new AppError(409, "TIKTOK_RECONNECT_REQUIRED");
      const token = await tiktokToken(
        c,
        { grant_type: "refresh_token", refresh_token: creds.refreshToken },
        fetcher,
      );
      if (token.open_id !== ch.external_id)
        throw new AppError(409, "TIKTOK_ACCOUNT_MISMATCH");
      next = {
        ...creds,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        refreshExpiresAt: new Date(
          Date.now() + token.refresh_expires_in * 1000,
        ).toISOString(),
      };
      expires = new Date(Date.now() + token.expires_in * 1000);
      scopes = token.scope.split(",");
      expiryKind = "known";
    }
  } else if (ch.platform === "facebook") {
    if (!c.META_APP_ID || !c.META_APP_SECRET) return null;
    const url = new URL(
      `https://graph.facebook.com/${c.META_GRAPH_VERSION}/debug_token`,
    );
    url.searchParams.set("input_token", creds.accessToken);
    const r = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${c.META_APP_ID}|${c.META_APP_SECRET}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const result: any = await r.json();
    if (!r.ok) throw new AppError(502, "META_TOKEN_CHECK_FAILED");
    const d = result.data;
    if (!d?.is_valid || String(d.app_id) !== c.META_APP_ID)
      throw new AppError(409, "META_RECONNECT_REQUIRED");
    scopes = d.scopes ?? [];
    expires = d.expires_at ? new Date(d.expires_at * 1000) : null;
    expiryKind =
      d.expires_at === 0
        ? "no_scheduled_expiry"
        : d.expires_at
          ? "known"
          : "unknown";
  }

  return { next, expires, expiryKind, scopes };
}
