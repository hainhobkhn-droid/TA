import { randomUUID } from "node:crypto";
import { transaction, type PgPool } from "../db/index.js";
import type { Config } from "../config.js";
import type { Actor } from "../auth/index.js";
import { decrypt } from "../channels/crypto.js";
import { channelAdapter } from "../channels/adapter.js";
import type { Metric } from "../channels/metrics.js";
import { AppError } from "../errors.js";
export function periodBounds(days: number, now = new Date()) {
  if (![1, 7, 28, 90].includes(days)) throw new AppError(400, "INVALID_PERIOD");
  const local = new Date(+now + 7 * 3600000);
  local.setUTCHours(0, 0, 0, 0);
  const start = new Date(+local - 7 * 3600000 - (days - 1) * 86400000);
  const previousEnd = start;
  const previousStart = new Date(+start - (+now - +start));
  return { start, end: now, previousStart, previousEnd };
}
export async function storeMetrics(
  pool: PgPool,
  businessId: string,
  channelId: string,
  rows: Metric[],
) {
  return transaction(pool, async (db) => {
    let n = 0;
    for (const r of rows) {
      if (
        !Number.isFinite(r.value) ||
        r.value < 0 ||
        r.value > Number.MAX_SAFE_INTEGER
      )
        throw new AppError(400, "INVALID_METRIC_VALUE");
      const inserted = await db.query(
        "INSERT INTO metric_snapshot(id,business_id,channel_id,object_id,metric,day,period,kind,value,source,source_end_time,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          businessId,
          channelId,
          r.objectId,
          r.metric,
          r.day,
          r.period,
          r.kind,
          r.value,
          r.source,
          r.sourceEndTime ?? null,
          r.metadata ?? {},
        ],
      );
      n += inserted.rowCount ?? 0;
    }
    return n;
  });
}
export async function collectMetrics(
  pool: PgPool,
  c: Config,
  fetcher: typeof fetch = fetch,
) {
  if (!c.AUDIENCE_METRICS_ENABLED) return;
  const channels = (
    await pool.query(
      "SELECT * FROM channel WHERE status='connected' AND credentials_encrypted IS NOT NULL AND next_metrics_at<=now() ORDER BY next_metrics_at LIMIT 5",
    )
  ).rows;
  for (const ch of channels) {
    const claimed = await pool.query(
      "UPDATE channel SET next_metrics_at=now()+interval '6 hours' WHERE id=$1 AND next_metrics_at<=now() RETURNING id",
      [ch.id],
    );
    if (!claimed.rowCount) continue;
    try {
      const token: any = decrypt(
        ch.credentials_encrypted,
        `${ch.business_id}:channel:${ch.id}`,
        c,
      );
      const posts = (
        await pool.query(
          "SELECT v.platform_id,v.updated_at AS scheduled_at,r.payload->>'format' AS format,length(r.payload->>'caption') AS caption_length,r.payload->'hashtags' AS tags FROM post_variant v JOIN post_revision r ON r.variant_id=v.id AND r.revision=v.revision WHERE v.channel_id=$1 AND v.status='published' AND v.platform_id IS NOT NULL AND v.scheduled_at>now()-interval '90 days' ORDER BY v.scheduled_at DESC LIMIT 30",
          [ch.id],
        )
      ).rows;
      const rows = await channelAdapter(ch.platform, {
        config: c,
        channel: ch,
        credentials: token,
        fetcher,
      }).fetchMetrics(posts);
      const n = await storeMetrics(pool, ch.business_id, ch.id, rows);
      await pool.query(
        "INSERT INTO metric_collection(id,business_id,channel_id,status,rows) VALUES($1,$2,$3,'succeeded',$4)",
        [randomUUID(), ch.business_id, ch.id, n],
      );
    } catch (e) {
      await pool.query(
        "INSERT INTO metric_collection(id,business_id,channel_id,status,reason) VALUES($1,$2,$3,'unavailable',$4)",
        [
          randomUUID(),
          ch.business_id,
          ch.id,
          e instanceof AppError ? e.code : "METRICS_FETCH_FAILED",
        ],
      );
    }
  }
}
export async function operations(
  pool: PgPool,
  a: Pick<Actor, "businessId" | "channelScope">,
  start: Date,
  end: Date,
  channelId?: string,
) {
  const args = [
    a.businessId,
    a.channelScope.includes("*"),
    a.channelScope,
    start,
    end,
    channelId ?? null,
  ];
  const where =
    "v.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND ($6::uuid IS NULL OR c.id=$6)";
  const counts = (
    await pool.query(
      `SELECT count(*)::int AS inquiries,count(*) FILTER(WHERE v.kind='manual')::int AS manual_inquiries,count(*) FILTER(WHERE d.autonomy IN ('draft_for_approval','human_only'))::int AS escalations,count(*) FILTER(WHERE d.status='sent' AND d.approved_by IS NULL)::int AS automated_sent,count(*) FILTER(WHERE d.status='sent')::int AS replies_sent,count(*) FILTER(WHERE d.status='would_have_sent')::int AS simulated_replies,count(*) FILTER(WHERE d.status IN ('needs_approval','queued','approved','sending') OR d.id IS NULL)::int AS unanswered FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN channel c ON c.id=v.channel_id LEFT JOIN reply_draft d ON d.message_id=m.id WHERE ${where} AND NOT m.from_business AND m.sent_at>=$4 AND m.sent_at<$5`,
      args,
    )
  ).rows[0];
  const response = (
    await pool.query(
      `SELECT avg(extract(epoch from(first_reply.sent_at-first_inquiry.sent_at))) AS first_response_seconds,count(first_reply.sent_at)::int AS sample_size,avg(extract(epoch from(v.resolved_at-first_inquiry.sent_at))) FILTER(WHERE v.resolved_at>=first_inquiry.sent_at) AS resolution_seconds FROM conversation v JOIN channel c ON c.id=v.channel_id JOIN LATERAL(SELECT min(sent_at) AS sent_at FROM message WHERE conversation_id=v.id AND NOT from_business) first_inquiry ON true LEFT JOIN LATERAL(SELECT min(x.completed_at) AS sent_at FROM reply_delivery x JOIN reply_draft d ON d.id=x.draft_id WHERE d.conversation_id=v.id AND x.status='sent')first_reply ON true WHERE ${where} AND first_inquiry.sent_at>=$4 AND first_inquiry.sent_at<$5 AND (first_reply.sent_at IS NULL OR first_reply.sent_at>=first_inquiry.sent_at)`,
      args,
    )
  ).rows[0];
  const daily = (
    await pool.query(
      `SELECT to_char(m.sent_at AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS day,count(*)::int AS inquiries,count(*) FILTER(WHERE d.status='sent')::int AS sent,count(*) FILTER(WHERE d.autonomy IN ('human_only','draft_for_approval'))::int AS escalations FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN channel c ON c.id=v.channel_id LEFT JOIN reply_draft d ON d.message_id=m.id WHERE ${where} AND NOT m.from_business AND m.sent_at>=$4 AND m.sent_at<$5 GROUP BY day ORDER BY day`,
      args,
    )
  ).rows;
  const reasons = (
    await pool.query(
      `SELECT reason,count(*)::int AS count FROM reply_draft d JOIN conversation v ON v.id=d.conversation_id JOIN channel c ON c.id=v.channel_id CROSS JOIN LATERAL jsonb_array_elements_text(d.checks->'reasons')reason WHERE ${where} AND d.created_at>=$4 AND d.created_at<$5 GROUP BY reason ORDER BY count DESC LIMIT 15`,
      args,
    )
  ).rows;
  const intentMix = (
    await pool.query(
      `SELECT intent,count(*)::int AS count FROM reply_draft d JOIN conversation v ON v.id=d.conversation_id JOIN channel c ON c.id=v.channel_id CROSS JOIN LATERAL jsonb_array_elements_text(d.analysis->'intents')intent WHERE ${where} AND d.created_at>=$4 AND d.created_at<$5 GROUP BY intent ORDER BY count DESC`,
      args,
    )
  ).rows;
  const hours = (
    await pool.query(
      `SELECT extract(dow from m.sent_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS weekday,extract(hour from m.sent_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour,count(*)::int AS count FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN channel c ON c.id=v.channel_id WHERE ${where} AND NOT m.from_business AND m.sent_at>=$4 AND m.sent_at<$5 GROUP BY weekday,hour ORDER BY weekday,hour`,
      args,
    )
  ).rows;
  const approvals = (
    await pool.query(
      `SELECT d.approved_by AS actor_id,count(*)::int AS count,avg(extract(epoch from(d.approved_at-d.created_at))) AS seconds FROM reply_draft d JOIN conversation v ON v.id=d.conversation_id JOIN channel c ON c.id=v.channel_id WHERE ${where} AND d.approved_at>=$4 AND d.approved_at<$5 GROUP BY d.approved_by`,
      args,
    )
  ).rows;
  const customers = (
    await pool.query(
      `SELECT count(*) FILTER(WHERE prior)::int AS returning,count(*) FILTER(WHERE NOT prior)::int AS new FROM (SELECT DISTINCT v.channel_id,v.customer_id,EXISTS(SELECT 1 FROM conversation older JOIN message om ON om.conversation_id=older.id WHERE older.channel_id=v.channel_id AND older.customer_id=v.customer_id AND NOT om.from_business AND om.sent_at<$4) AS prior FROM conversation v JOIN channel c ON c.id=v.channel_id JOIN message m ON m.conversation_id=v.id WHERE ${where} AND NOT m.from_business AND m.sent_at>=$4 AND m.sent_at<$5) q`,
      args,
    )
  ).rows[0];
  const askedProducts = (
    await pool.query(
      `SELECT fact->>'recordKey' AS sku,count(DISTINCT d.id)::int AS inquiries FROM reply_draft d JOIN conversation v ON v.id=d.conversation_id JOIN channel c ON c.id=v.channel_id CROSS JOIN LATERAL jsonb_array_elements(d.facts) fact WHERE ${where} AND d.created_at>=$4 AND d.created_at<$5 AND fact->>'dataset'='products' GROUP BY sku ORDER BY inquiries DESC LIMIT 20`,
      args,
    )
  ).rows;
  return {
    ...counts,
    automation_rate: counts.replies_sent
      ? counts.automated_sent / counts.replies_sent
      : null,
    escalation_rate: counts.inquiries
      ? counts.escalations / counts.inquiries
      : null,
    first_response_seconds:
      response.first_response_seconds === null
        ? null
        : Number(response.first_response_seconds),
    response_sample_size: response.sample_size,
    resolution_seconds:
      response.resolution_seconds === null
        ? null
        : Number(response.resolution_seconds),
    daily,
    reasons,
    intentMix,
    askedProducts,
    hours,
    approvals,
    customers,
  };
}
export async function report(
  pool: PgPool,
  a: Pick<Actor, "businessId" | "channelScope">,
  days: number,
  channelId?: string,
  now = new Date(),
) {
  const bounds = periodBounds(days, now);
  const [current, previous, snapshots, collections] = await Promise.all([
    operations(pool, a, bounds.start, bounds.end, channelId),
    operations(pool, a, bounds.previousStart, bounds.previousEnd, channelId),
    pool.query(
      "SELECT m.*,c.display_name,c.platform FROM metric_snapshot m JOIN channel c ON c.id=m.channel_id WHERE m.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND ($4::uuid IS NULL OR c.id=$4) AND m.day>=$5::date ORDER BY m.day DESC,m.metric LIMIT 15001",
      [
        a.businessId,
        a.channelScope.includes("*"),
        a.channelScope,
        channelId ?? null,
        bounds.previousStart,
      ],
    ),
    pool.query(
      "SELECT DISTINCT ON(x.channel_id) x.*,c.display_name FROM metric_collection x JOIN channel c ON c.id=x.channel_id WHERE x.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND ($4::uuid IS NULL OR c.id=$4) ORDER BY x.channel_id,x.created_at DESC",
      [
        a.businessId,
        a.channelScope.includes("*"),
        a.channelScope,
        channelId ?? null,
      ],
    ),
  ]);
  const links = (
    await pool.query(
      "SELECT l.id,l.conversation_id,l.order_version_id,k.data FROM inquiry_order_link l JOIN conversation v ON v.id=l.conversation_id JOIN channel c ON c.id=v.channel_id JOIN knowledge_version k ON k.id=l.order_version_id WHERE l.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND ($4::uuid IS NULL OR c.id=$4) AND l.created_at>=$5 AND l.created_at<$6",
      [
        a.businessId,
        a.channelScope.includes("*"),
        a.channelScope,
        channelId ?? null,
        bounds.start,
        bounds.end,
      ],
    )
  ).rows;
  const cohort = (
    await pool.query(
      "SELECT count(*)::int AS conversations,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM inquiry_order_link l WHERE l.conversation_id=v.id AND l.created_at<$6))::int AS converted FROM conversation v JOIN channel c ON c.id=v.channel_id WHERE v.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND ($4::uuid IS NULL OR c.id=$4) AND EXISTS(SELECT 1 FROM message m WHERE m.conversation_id=v.id AND NOT m.from_business AND m.sent_at>=$5 AND m.sent_at<$6)",
      [
        a.businessId,
        a.channelScope.includes("*"),
        a.channelScope,
        channelId ?? null,
        bounds.start,
        bounds.end,
      ],
    )
  ).rows[0];
  const ordersAvailable = !!(
    await pool.query(
      "SELECT 1 FROM knowledge_source WHERE business_id=$1 AND dataset='orders' LIMIT 1",
      [a.businessId],
    )
  ).rowCount;
  const revenue: Record<string, number> = {},
    products: Record<string, number> = {};
  for (const l of links) {
    if (typeof l.data.total === "number")
      revenue[l.data.currency ?? "VND"] =
        (revenue[l.data.currency ?? "VND"] ?? 0) + l.data.total;
    for (const line of l.data.lines ?? []) {
      const key = line.sku + " · " + (l.data.currency ?? "VND");
      products[key] = (products[key] ?? 0) + line.line_total;
    }
  }
  return {
    bounds,
    current,
    previous,
    snapshots: snapshots.rows.slice(0, 15000).reverse(),
    snapshotsTruncated: snapshots.rows.length > 15000,
    collections: collections.rows,
    audienceNote:
      "Source metric periods are preserved. Daily unique viewers are not additive. Cumulative/gauge values are observations, not daily gains. Missing history is not zero.",
    conversion: {
      available: ordersAvailable,
      inquiryConversations: cohort.conversations,
      convertedConversations: cohort.converted,
      rate:
        ordersAvailable && cohort.conversations
          ? cohort.converted / cohort.conversations
          : null,
      rateDefinition:
        "Conversations with an inbound message in the selected period and a staff-confirmed order link by period end, divided by conversations with an inbound message in the period. A conversation counts once; not causal attribution.",
      linkedOrders: links.length,
      linkedConversations: new Set(links.map((l) => l.conversation_id)).size,
      revenue,
      products,
      evidence: links.map((l) => ({
        linkId: l.id,
        conversationId: l.conversation_id,
        orderVersionId: l.order_version_id,
      })),
      definition:
        "Human-confirmed order links created in the selected period. Revenue uses the immutable order version at linking; product revenue requires explicit lines. Not causal attribution.",
    },
  };
}
