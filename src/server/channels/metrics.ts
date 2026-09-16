import { createHmac } from "node:crypto";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { tiktokCall } from "./tiktok.js";
export type Metric = {
  objectId: string;
  metric: string;
  day: string;
  period: string;
  kind: "daily" | "cumulative" | "gauge";
  value: number;
  source: string;
  sourceEndTime?: string;
  metadata?: Record<string, unknown>;
};
const day = (d = new Date()) =>
  new Date(+d + 7 * 3600000).toISOString().slice(0, 10);
export async function fetchFacebookMetrics(
  c: Config,
  ch: any,
  token: string,
  posts: {
    platform_id: string;
    scheduled_at: Date;
    format?: string;
    caption_length?: number;
    tags?: unknown;
  }[],
  fetcher: typeof fetch = fetch,
): Promise<Metric[]> {
  if (
    !ch.granted_scopes.includes("read_insights") ||
    !ch.granted_scopes.includes("pages_read_engagement")
  )
    throw new AppError(409, "METRICS_SCOPE_REQUIRED");
  const out: Metric[] = [];
  async function query(
    objectId: string,
    metric: string,
    period: string,
    kind: Metric["kind"],
    metadata: Record<string, unknown> = {},
    video = false,
  ) {
    if (!/^[\d_]+$/.test(objectId))
      throw new AppError(400, "INVALID_META_OBJECT");
    const u = new URL(
      `https://graph.facebook.com/${c.META_GRAPH_VERSION}/${objectId}/${video ? "video_insights" : "insights/" + metric}`,
    );
    u.searchParams.set("period", period);
    if (video) u.searchParams.set("metric", metric);
    u.searchParams.set(
      "appsecret_proof",
      createHmac("sha256", c.META_APP_SECRET).update(token).digest("hex"),
    );
    if (period === "day") {
      u.searchParams.set(
        "since",
        String(Math.floor(Date.now() / 1000) - 93 * 86400),
      );
      u.searchParams.set("until", String(Math.floor(Date.now() / 1000)));
    }
    const r = await fetcher(u, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await r.json();
    if (!r.ok || data.error) throw new AppError(502, "META_METRIC_UNAVAILABLE");
    for (const item of data.data ?? [])
      for (const v of item.values ?? []) {
        if (
          period === "day" &&
          (!v.end_time || Date.parse(v.end_time) > Date.now())
        )
          continue;
        if (
          !Number.isFinite(v.value) ||
          v.value < 0 ||
          v.value > Number.MAX_SAFE_INTEGER
        )
          continue;
        out.push({
          objectId,
          metric: item.name,
          day:
            period === "day" && v.end_time
              ? new Date(Date.parse(v.end_time) - 86400000)
                  .toISOString()
                  .slice(0, 10)
              : day(),
          period,
          kind,
          value: v.value,
          source: `meta:${c.META_GRAPH_VERSION}`,
          sourceEndTime: v.end_time,
          metadata,
        });
      }
  }
  // A missing field remains missing. Individual metric failures do not fabricate zeroes.
  for (const metric of [
    "page_media_view",
    "page_total_media_view_unique",
    "page_follows",
  ]) {
    try {
      await query(
        ch.external_id,
        metric,
        "day",
        metric === "page_follows" ? "gauge" : "daily",
      );
    } catch {}
  }
  for (const p of posts.slice(0, 30))
    for (const metric of [
      "post_media_view",
      "post_total_media_view_unique",
      "post_reactions_like_total",
      "post_reactions_love_total",
    ]) {
      try {
        await query(p.platform_id, metric, "lifetime", "cumulative", {
          publishedAt: p.scheduled_at,
        });
      } catch {}
    }
  if (ch.granted_scopes.includes("pages_manage_engagement"))
    for (const p of posts.filter((p) =>
      ["reel", "video"].includes(p.format ?? ""),
    ))
      for (const metric of p.format === "reel"
        ? [
            "fb_reels_total_plays",
            "post_video_avg_time_watched",
            "post_video_view_time",
          ]
        : [
            "total_video_views",
            "total_video_complete_views",
            "total_video_avg_time_watched",
            "total_video_view_total_time",
          ]) {
        try {
          await query(
            p.platform_id,
            metric,
            "lifetime",
            metric.includes("avg") ? "gauge" : "cumulative",
            {
              publishedAt: p.scheduled_at,
              format: p.format,
              unit: metric.includes("time") ? "milliseconds" : "count",
            },
            true,
          );
        } catch {}
      }
  if (!out.length) throw new AppError(502, "META_METRICS_UNAVAILABLE");
  return out;
}
export async function fetchTikTokMetrics(
  c: Config,
  ch: any,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Metric[]> {
  const out: Metric[] = [];
  const today = day();
  if (ch.granted_scopes.includes("user.info.stats")) {
    const r = await fetcher(
      "https://open.tiktokapis.com/v2/user/info/?fields=follower_count,likes_count,video_count",
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    const d: any = await r.json();
    if (r.ok && d.error?.code === "ok")
      for (const key of ["follower_count", "likes_count", "video_count"]) {
        const value = d.data?.user?.[key];
        if (Number.isSafeInteger(value) && value >= 0)
          out.push({
            objectId: ch.external_id,
            metric: key,
            day: today,
            period: "observed",
            kind: "gauge",
            value,
            source: "tiktok:v2",
          });
      }
  }
  if (ch.granted_scopes.includes("video.list")) {
    let cursor: number | undefined;
    for (let page = 0; page < 20; page++) {
      const data = await tiktokCall(
        "video/list/?fields=id,create_time,title,share_url,like_count,comment_count,share_count,view_count",
        token,
        { max_count: 20, ...(cursor ? { cursor } : {}) },
        fetcher,
      );
      for (const v of data.videos ?? []) {
        if (typeof v.id !== "string") continue;
        for (const metric of [
          "like_count",
          "comment_count",
          "share_count",
          "view_count",
        ])
          if (Number.isSafeInteger(v[metric]) && v[metric] >= 0)
            out.push({
              objectId: v.id,
              metric,
              day: today,
              period: "lifetime_observed",
              kind: "cumulative",
              value: v[metric],
              source: "tiktok:v2",
              metadata: {
                publishedAt: Number.isFinite(v.create_time)
                  ? new Date(v.create_time * 1000).toISOString()
                  : null,
                title: v.title,
                permalink: v.share_url,
              },
            });
      }
      if (!data.has_more) break;
      if (!Number.isSafeInteger(data.cursor) || data.cursor === cursor)
        throw new AppError(502, "INVALID_METRIC_CURSOR");
      cursor = data.cursor;
    }
  }
  if (!out.length)
    throw new AppError(409, "TIKTOK_METRICS_SCOPE_OR_DATA_UNAVAILABLE");
  return out;
}
