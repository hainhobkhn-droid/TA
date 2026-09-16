import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
export function verifyMeta(
  body: Buffer,
  header: string | undefined,
  secret: string,
) {
  if (!secret || !header || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(header.slice(7)), Buffer.from(expected));
}
export function metaReplyPayload(
  kind: string,
  pageId: string,
  customerId: string,
  commentId: string,
  text: string,
) {
  return kind === "messenger"
    ? {
        endpoint: `/${pageId}/messages`,
        body: {
          recipient: { id: customerId },
          messaging_type: "RESPONSE",
          message: { text },
        },
      }
    : { endpoint: `/${commentId}/comments`, body: { message: text } };
}
export async function sendMetaReply(
  c: Config,
  token: string,
  payload: ReturnType<typeof metaReplyPayload>,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(
    `https://graph.facebook.com/${c.META_GRAPH_VERSION}${payload.endpoint}`,
  );
  url.searchParams.set(
    "appsecret_proof",
    createHmac("sha256", c.META_APP_SECRET).update(token).digest("hex"),
  );
  try {
    const r = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload.body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const d: any = await r.json();
    if (!r.ok || d.error)
      throw new AppError(
        502,
        d.error?.code === 190
          ? "META_RECONNECT_REQUIRED"
          : "META_SEND_REJECTED",
      );
    const id = d.message_id ?? d.id;
    if (typeof id !== "string")
      throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
    return { id };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, "EXTERNAL_OUTCOME_UNKNOWN");
  }
}
export type Incoming = {
  pageId: string;
  threadId: string;
  customerId: string;
  externalId: string;
  text: string;
  fromBusiness: boolean;
  kind: "messenger" | "comment";
  sentAt: string;
  attachments: unknown[];
};
export function normalizeMeta(payload: any): Incoming[] {
  const messages: Incoming[] = [];
  if (payload.object !== "page") return messages;
  for (const e of payload.entry ?? []) {
    if (typeof e.id !== "string") continue;
    for (const m of e.messaging ?? []) {
      if (
        !m.message?.mid ||
        !m.sender?.id ||
        !m.recipient?.id ||
        !Number.isFinite(m.timestamp)
      )
        continue;
      const own = !!m.message.is_echo || m.sender.id === e.id;
      const customer = own ? m.recipient.id : m.sender.id;
      messages.push({
        pageId: e.id,
        threadId: customer,
        customerId: customer,
        externalId: m.message.mid,
        text:
          typeof m.message.text === "string"
            ? m.message.text.slice(0, 4000)
            : "[attachment requires human review]",
        fromBusiness: own,
        kind: "messenger",
        sentAt: new Date(m.timestamp).toISOString(),
        attachments: (m.message.attachments ?? [])
          .slice(0, 10)
          .map((a: any) => ({ type: a.type, url: a.payload?.url })),
      });
    }
    for (const ch of e.changes ?? []) {
      const v = ch.value;
      if (
        ch.field !== "feed" ||
        v?.item !== "comment" ||
        v.verb !== "add" ||
        !v.comment_id ||
        !v.from?.id
      )
        continue;
      messages.push({
        pageId: e.id,
        threadId: `comment:${v.comment_id}`,
        customerId: String(v.from.id),
        externalId: String(v.comment_id),
        text:
          typeof v.message === "string"
            ? v.message.slice(0, 4000)
            : "[comment attachment requires human review]",
        fromBusiness: String(v.from.id) === e.id,
        kind: "comment",
        sentAt: new Date(Number(v.created_time ?? e.time) * 1000).toISOString(),
        attachments: [],
      });
    }
  }
  return messages;
}
