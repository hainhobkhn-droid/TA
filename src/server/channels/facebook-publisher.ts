import { createHmac } from "node:crypto";
import { openAsBlob, createReadStream } from "node:fs";
import type { Config } from "../config.js";
import type { PublishPayload, MediaInfo } from "../../shared/publishing.js";
import { AppError } from "../errors.js";
export type Step = <T>(
  name: string,
  payload: unknown,
  send: () => Promise<T>,
) => Promise<T>;
export type PublishResult = {
  outcome: "published" | "needs_action";
  platformId?: string;
  permalink?: string;
  reason?: string;
};
export interface PublishingTransport {
  publish(p: PublishPayload): Promise<PublishResult>;
}
export function facebookPublisher(
  c: Config,
  credentials: { accessToken: string; userAccessToken?: string },
  step: Step,
  file: (m: MediaInfo) => Promise<string>,
  fetcher: typeof fetch = fetch,
): PublishingTransport {
  const token = credentials.accessToken;
  const base = `https://graph.facebook.com/${c.META_GRAPH_VERSION}/`;
  async function request(
    path: string,
    body?: any,
    otherToken = token,
    host = base,
    headers: Record<string, string> = {},
  ) {
    // Upload session IDs contain a colon. Append them as a path, never as a URL scheme.
    const url = new URL(host + path.replace(/^\/+/, ""));
    if (
      url.protocol !== "https:" ||
      !["graph.facebook.com", "graph-video.facebook.com"].includes(
        url.hostname,
      ) ||
      url.port ||
      url.username ||
      url.password
    )
      throw new AppError(502, "META_ENDPOINT_REJECTED");
    url.searchParams.set(
      "appsecret_proof",
      createHmac("sha256", c.META_APP_SECRET).update(otherToken).digest("hex"),
    );
    let r: Response;
    try {
      r = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${otherToken}`,
          ...(body instanceof FormData
            ? {}
            : body && typeof body === "object" && !("pipe" in body)
              ? { "Content-Type": "application/json" }
              : {}),
          ...headers,
        },
        body:
          body instanceof FormData || body?.pipe
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
        signal: AbortSignal.timeout(120000),
        redirect: "error",
        ...(body?.pipe ? { duplex: "half" } : {}),
      } as unknown as RequestInit);
    } catch {
      throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
    }
    let data: any;
    try {
      data = await r.json();
    } catch {
      throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
    }
    if (!r.ok || data.error)
      throw new AppError(
        502,
        data.error?.code === 190
          ? "META_RECONNECT_REQUIRED"
          : "META_REQUEST_REJECTED",
      );
    return data;
  }
  const caption = (p: PublishPayload) =>
    [p.caption, p.hashtags.join(" ")].filter(Boolean).join("\n");
  const objectId = (id: unknown): string => {
    if (typeof id !== "string" || !/^\d+(?:_\d+)?$/.test(id))
      throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
    return id;
  };
  return {
    async publish(p) {
      if (!p.pageId) throw new AppError(409, "CHANNEL_NOT_CONNECTED");
      objectId(p.pageId);
      let id: string;
      if (p.format === "text") {
        const body = { message: caption(p), published: true };
        const r = await step(
          "publish",
          { endpoint: `/${p.pageId}/feed`, body },
          () => request(`${p.pageId}/feed`, body),
        );
        id = r.id;
      } else if (p.format === "photo" || p.format === "multi_photo") {
        const attached = [];
        for (const m of p.media) {
          const published = p.format === "photo";
          const body = {
            published,
            caption: published ? caption(p) : "",
            media: { id: m.id, sha256: m.sha256 },
          };
          const r = await step(
            `photo:${m.id}`,
            { endpoint: `/${p.pageId}/photos`, body },
            async () => {
              const f = new FormData();
              f.set("published", String(published));
              if (published) f.set("caption", caption(p));
              f.set(
                "source",
                await openAsBlob(await file(m), { type: m.mime }),
                m.name ?? "photo",
              );
              return request(`${p.pageId}/photos`, f);
            },
          );
          if (published) {
            id = r.post_id ?? r.id;
            attached.length = 0;
            break;
          }
          attached.push({ media_fbid: objectId(r.id) });
        }
        if (attached.length) {
          const body = {
            message: caption(p),
            attached_media: attached,
            published: true,
          };
          const r = await step(
            "publish",
            { endpoint: `/${p.pageId}/feed`, body },
            () => request(`${p.pageId}/feed`, body),
          );
          id = r.id;
        }
      } else if (p.format === "reel") {
        const m = p.media[0];
        const start = await step(
          "reel:start",
          {
            endpoint: `/${p.pageId}/video_reels`,
            body: { upload_phase: "start" },
          },
          () => request(`${p.pageId}/video_reels`, { upload_phase: "start" }),
        );
        if (!start.video_id)
          throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
        objectId(start.video_id);
        const u = new URL(start.upload_url);
        if (
          u.protocol !== "https:" ||
          u.hostname !== "rupload.facebook.com" ||
          u.port ||
          u.username ||
          u.password
        )
          throw new AppError(502, "META_UPLOAD_URL_REJECTED");
        await step(
          "reel:upload",
          { endpoint: u.origin + u.pathname, media: m, offset: 0 },
          async () => {
            const response = await fetcher(u, {
              method: "POST",
              headers: {
                Authorization: `OAuth ${token}`,
                offset: "0",
                file_size: String(m.bytes),
                "Content-Type": "application/octet-stream",
              },
              body: createReadStream(await file(m)),
              duplex: "half",
              redirect: "error",
              signal: AbortSignal.timeout(120000),
            } as unknown as RequestInit);
            const data: any = await response.json();
            if (!response.ok || !data.success)
              throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
            return { success: true };
          },
        );
        const status = await request(`${start.video_id}?fields=status`);
        if (
          status.status?.video_status !== "ready" &&
          status.status?.processing_phase?.status !== "completed"
        )
          return {
            outcome: "needs_action",
            platformId: start.video_id,
            reason: "META_VIDEO_PROCESSING",
          };
        const body = {
          upload_phase: "finish",
          video_id: start.video_id,
          video_state: "PUBLISHED",
          description: caption(p),
        };
        await step(
          "publish",
          { endpoint: `/${p.pageId}/video_reels`, body },
          () => request(`${p.pageId}/video_reels`, body),
        );
        const published = await request(`${start.video_id}?fields=status`);
        if (
          published.status?.publishing_phase?.status !== "completed" ||
          published.status?.publishing_phase?.publish_status !== "published"
        )
          return {
            outcome: "needs_action",
            platformId: start.video_id,
            reason: "META_REEL_PUBLISHING_PENDING",
          };
        id = start.video_id;
      } else if (p.format === "video") {
        if (!credentials.userAccessToken)
          throw new AppError(409, "META_USER_TOKEN_RECONNECT");
        const m = p.media[0];
        const body = {
          file_name: m.name ?? "video.mp4",
          file_length: m.bytes,
          file_type: "video/mp4",
        };
        const s = await step(
          "video:start",
          { endpoint: `/${c.META_APP_ID}/uploads`, body },
          () =>
            request(
              `${c.META_APP_ID}/uploads`,
              body,
              credentials.userAccessToken,
            ),
        );
        if (
          typeof s.id !== "string" ||
          !/^upload:[A-Za-z0-9_:=.-]+$/.test(s.id)
        )
          throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
        const h = await step(
          "video:upload",
          { endpoint: `/${s.id}`, media: m, offset: 0 },
          async () =>
            request(
              s.id,
              createReadStream(await file(m)),
              credentials.userAccessToken,
              base,
              {
                Authorization: `OAuth ${credentials.userAccessToken}`,
                file_offset: "0",
                "Content-Type": "application/octet-stream",
              },
            ),
        );
        const publish = {
          description: caption(p),
          fbuploader_video_file_chunk: h.h,
        };
        const r = await step(
          "publish",
          {
            endpoint: `/${p.pageId}/videos`,
            body: { description: caption(p), uploadedMediaSha256: m.sha256 },
          },
          () =>
            request(
              `${p.pageId}/videos`,
              publish,
              token,
              `https://graph-video.facebook.com/${c.META_GRAPH_VERSION}/`,
            ),
        );
        id = r.id;
      } else throw new AppError(400, "UNSUPPORTED_FORMAT");
      if (!id!) throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
      objectId(id);
      if (p.firstComment) {
        const body = { message: p.firstComment };
        await step("first_comment", { endpoint: `/${id}/comments`, body }, () =>
          request(`${id}/comments`, body),
        );
      }
      return {
        outcome: "published",
        platformId: id,
        permalink: `https://www.facebook.com/${id}`,
      };
    },
  };
}
