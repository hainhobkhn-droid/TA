import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { PublishPayload, MediaInfo } from "../../shared/publishing.js";
import {
  facebookPublisher,
  type Step,
  type PublishResult,
} from "./facebook-publisher.js";
import { tiktokPublisher } from "./tiktok.js";
import {
  normalizeMeta,
  verifyMeta,
  metaReplyPayload,
  sendMetaReply,
  type Incoming,
} from "./facebook-messaging.js";
import {
  fetchFacebookMetrics,
  fetchTikTokMetrics,
  type Metric,
} from "./metrics.js";
import { refreshChannelCredentials } from "./credentials.js";
export type CapabilityMode = "live" | "manual" | "unavailable";
export type ReplyCommand = {
  kind: string;
  pageId: string;
  customerId: string;
  threadId: string;
  text: string;
};
export type ReplyPayload = ReturnType<typeof metaReplyPayload>;
export type ReplySender = typeof sendMetaReply;
type Context = {
  config?: Config;
  channel?: any;
  credentials?: any;
  step?: Step;
  file?: (media: MediaInfo) => Promise<string>;
  fetcher?: typeof fetch;
};
export interface ChannelAdapter {
  capabilities(): Record<
    | "publish"
    | "fetchInbox"
    | "sendReply"
    | "fetchMetrics"
    | "verifyWebhook"
    | "refreshCredentials",
    CapabilityMode
  >;
  publish(payload: PublishPayload): Promise<PublishResult>;
  fetchInbox(payload?: unknown): Promise<Incoming[]>;
  prepareReply(command: ReplyCommand): ReplyPayload;
  sendReply(
    payload: ReplyPayload,
  ): Promise<{ id?: string; outcome: "sent" | "needs_action" }>;
  fetchMetrics(
    posts?: Parameters<typeof fetchFacebookMetrics>[3],
  ): Promise<Metric[]>;
  verifyWebhook(
    body: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean;
  refreshCredentials(): Promise<
    Awaited<ReturnType<typeof refreshChannelCredentials>>
  >;
}
export class ManualAdapter implements ChannelAdapter {
  capabilities(): ReturnType<ChannelAdapter["capabilities"]> {
    return {
      publish: "manual",
      fetchInbox: "manual",
      sendReply: "manual",
      fetchMetrics: "unavailable",
      verifyWebhook: "unavailable",
      refreshCredentials: "unavailable",
    } as const;
  }
  async publish(_payload: PublishPayload): Promise<PublishResult> {
    return { outcome: "needs_action", reason: "MANUAL_PUBLICATION_REQUIRED" };
  }
  async fetchInbox(_payload?: unknown): Promise<Incoming[]> {
    return [];
  }
  prepareReply(command: ReplyCommand): ReplyPayload {
    return { endpoint: "manual", body: { message: command.text } };
  }
  async sendReply(
    _payload: ReplyPayload,
  ): Promise<{ id?: string; outcome: "sent" | "needs_action" }> {
    return { outcome: "needs_action" };
  }
  async fetchMetrics(): Promise<Metric[]> {
    throw new AppError(409, "METRICS_UNAVAILABLE");
  }
  verifyWebhook(_body: Buffer, _headers: Record<string, string | undefined>) {
    return false;
  }
  async refreshCredentials(): Promise<
    Awaited<ReturnType<typeof refreshChannelCredentials>>
  > {
    return null;
  }
}
class PlatformAdapter extends ManualAdapter {
  constructor(
    private platform: "facebook" | "tiktok",
    private context: Context,
  ) {
    super();
  }
  private config() {
    if (!this.context.config)
      throw new AppError(500, "ADAPTER_CONTEXT_REQUIRED");
    return this.context.config;
  }
  capabilities(): ReturnType<ChannelAdapter["capabilities"]> {
    const scopes: string[] = this.context.channel?.granted_scopes ?? [];
    const has = (scope: string): CapabilityMode =>
      scopes.includes(scope) ? "live" : "manual";
    return {
      publish: has(
        this.platform === "facebook" ? "pages_manage_posts" : "video.publish",
      ),
      fetchInbox: this.platform === "facebook" ? "live" : "manual",
      sendReply:
        this.platform === "facebook" &&
        (scopes.includes("pages_messaging") ||
          scopes.includes("pages_manage_engagement"))
          ? "live"
          : "manual",
      fetchMetrics: scopes.includes(
        this.platform === "facebook" ? "read_insights" : "video.list",
      )
        ? "live"
        : "unavailable",
      verifyWebhook: this.platform === "facebook" ? "live" : "unavailable",
      refreshCredentials: "live",
    };
  }
  async publish(payload: PublishPayload): Promise<PublishResult> {
    const x = this.context;
    if (!x.step || !x.credentials)
      throw new AppError(409, "CHANNEL_NOT_CONNECTED");
    if (this.platform === "tiktok")
      return tiktokPublisher(
        this.config(),
        x.credentials.accessToken,
        x.step,
        x.fetcher,
      ).publish(payload);
    if (!x.file) throw new AppError(500, "ADAPTER_MEDIA_REQUIRED");
    return facebookPublisher(
      this.config(),
      x.credentials,
      x.step,
      x.file,
      x.fetcher,
    ).publish(payload);
  }
  async fetchInbox(payload?: unknown) {
    return this.platform === "facebook"
      ? normalizeMeta(payload)
      : super.fetchInbox(payload);
  }
  prepareReply(command: ReplyCommand) {
    return this.platform === "facebook"
      ? metaReplyPayload(
          command.kind,
          command.pageId,
          command.customerId,
          command.threadId.replace(/^comment:/, ""),
          command.text,
        )
      : super.prepareReply(command);
  }
  async sendReply(
    payload: ReplyPayload,
  ): Promise<{ id?: string; outcome: "sent" | "needs_action" }> {
    if (this.platform !== "facebook") return super.sendReply(payload);
    return {
      ...(await sendMetaReply(
        this.config(),
        this.context.credentials?.accessToken,
        payload,
        this.context.fetcher,
      )),
      outcome: "sent",
    };
  }
  async fetchMetrics(posts: Parameters<typeof fetchFacebookMetrics>[3] = []) {
    const x = this.context;
    return this.platform === "facebook"
      ? fetchFacebookMetrics(
          this.config(),
          x.channel,
          x.credentials?.accessToken,
          posts,
          x.fetcher,
        )
      : fetchTikTokMetrics(
          this.config(),
          x.channel,
          x.credentials?.accessToken,
          x.fetcher,
        );
  }
  verifyWebhook(body: Buffer, headers: Record<string, string | undefined>) {
    return (
      this.platform === "facebook" &&
      verifyMeta(
        body,
        headers["x-hub-signature-256"],
        this.config().META_APP_SECRET,
      )
    );
  }
  async refreshCredentials() {
    const x = this.context;
    return refreshChannelCredentials(
      this.config(),
      x.channel,
      x.credentials,
      x.fetcher,
    );
  }
}
export function channelAdapter(
  platform: string,
  context: Context = {},
): ChannelAdapter {
  return platform === "facebook" || platform === "tiktok"
    ? new PlatformAdapter(platform, context)
    : new ManualAdapter();
}
