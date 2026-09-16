import { randomUUID } from "node:crypto";
import type { PgPool } from "../db/index.js";
import { operations } from "../metrics/service.js";
export type InsightDraft = {
  detector: string;
  evidence: Record<string, unknown>;
  recommendation: {
    title: string;
    titleVi: string;
    action: string;
    details: string;
  };
};
export function detectOperations(
  current: any,
  previous: any,
  unanswered: { id: string; count: number }[],
): InsightDraft[] {
  const out: InsightDraft[] = [];
  if (current.reasons.length) {
    const top = current.reasons[0];
    out.push({
      detector: "top_escalation",
      evidence: {
        reason: top.reason,
        count: top.count,
        inquiries: current.inquiries,
      },
      recommendation: {
        title: "Resolve the most common escalation reason",
        titleVi: "Xử lý lý do chuyển người phổ biến nhất",
        action:
          String(top.reason).includes("FACT") ||
          String(top.reason).includes("PRODUCT")
            ? "knowledge"
            : "rules",
        details: `${top.reason}: ${top.count} occurrences across ${current.inquiries} inquiries.`,
      },
    });
  }
  const stale = current.reasons.filter((r: any) =>
    String(r.reason).startsWith("STALE_FACT"),
  );
  if (stale.length)
    out.push({
      detector: "stale_data",
      evidence: {
        reasons: stale,
        definition:
          "Reason occurrences; one inquiry can have multiple stale fields.",
      },
      recommendation: {
        title: "Confirm and refresh stale source fields",
        titleVi: "Xác nhận và cập nhật dữ liệu quá hạn",
        action: "knowledge",
        details: stale.map((x: any) => `${x.reason}: ${x.count}`).join("; "),
      },
    });
  if (
    current.response_sample_size >= 5 &&
    previous.response_sample_size >= 5 &&
    previous.first_response_seconds > 0 &&
    current.first_response_seconds > previous.first_response_seconds * 1.25
  )
    out.push({
      detector: "response_degradation",
      evidence: {
        currentSeconds: current.first_response_seconds,
        previousSeconds: previous.first_response_seconds,
        currentN: current.response_sample_size,
        previousN: previous.response_sample_size,
        ratio: current.first_response_seconds / previous.first_response_seconds,
      },
      recommendation: {
        title: "Review coverage during busy hours",
        titleVi: "Xem lại lịch trực giờ cao điểm",
        action: "team",
        details:
          "Average first response is at least 25% slower; compare matched periods and staffing.",
      },
    });
  if (unanswered.length)
    out.push({
      detector: "repeat_unanswered",
      evidence: {
        conversations: unanswered,
        conversationCount: unanswered.length,
      },
      recommendation: {
        title: "Follow up with customers who asked twice",
        titleVi: "Liên hệ khách đã hỏi nhiều lần",
        action: "inbox",
        details: `${unanswered.length} unresolved conversations have at least two incoming messages and no confirmed reply.`,
      },
    });
  return out;
}
export function detectPosts(rows: any[]): InsightDraft[] {
  const groups = new Map<
    string,
    {
      id: string;
      value: number;
      hour: number;
      format: string;
      captionLength: number;
    }[]
  >();
  for (const r of rows) {
    if (
      !["post_media_view", "view_count"].includes(r.metric) ||
      !r.metadata?.publishedAt
    )
      continue;
    const date = new Date(r.metadata.publishedAt);
    if (!Number.isFinite(+date)) continue;
    const key = r.metric;
    const list = groups.get(key) ?? [];
    const item = {
      id: r.object_id,
      value: Number(r.value),
      hour: new Date(+date + 7 * 3600000).getUTCHours(),
      format: r.metadata.format ?? "unknown",
      captionLength: Number(r.metadata.captionLength ?? 0),
    };
    const old = list.findIndex((x) => x.id === item.id);
    if (old >= 0) list[old] = item;
    else list.push(item);
    groups.set(key, list);
  }
  const out: InsightDraft[] = [];
  for (const [metric, posts] of groups) {
    if (posts.length < 10) continue;
    const sorted = posts.map((p) => p.value).sort((a, b) => a - b);
    const median =
      (sorted[Math.floor((sorted.length - 1) / 2)] +
        sorted[Math.ceil((sorted.length - 1) / 2)]) /
      2;
    if (median <= 0) continue;
    const bins = Array.from({ length: 12 }, (_, i) => ({
      start: i * 2,
      posts: posts.filter((p) => Math.floor(p.hour / 2) === i),
    }))
      .filter((b) => b.posts.length >= 3)
      .map((b) => ({
        ...b,
        average: b.posts.reduce((n, p) => n + p.value, 0) / b.posts.length,
      }))
      .sort((a, b) => b.average - a.average);
    if (bins[0])
      out.push({
        detector: "posting_hours",
        evidence: {
          metric,
          windowStart: bins[0].start,
          windowEnd: bins[0].start + 2,
          windowN: bins[0].posts.length,
          windowAverage: bins[0].average,
          overallMedian: median,
          n: posts.length,
          ratio: bins[0].average / median,
          postIds: bins[0].posts.map((p) => p.id),
          limitation:
            "Observational lifetime counters, affected by post age; association is not causation.",
        },
        recommendation: {
          title: "Test a posting window with stronger observed results",
          titleVi: "Thử khung giờ có kết quả quan sát tốt hơn",
          action: "publisher",
          details: `${bins[0].start}:00–${bins[0].start + 2}:00 Asia/Ho_Chi_Minh; ${metric}. Review post age before changing the schedule.`,
        },
      });
    const extremes = posts.filter(
      (p) => p.value >= median * 2 || p.value < median * 0.5,
    );
    if (extremes.length)
      out.push({
        detector: "post_outliers",
        evidence: {
          metric,
          median,
          n: posts.length,
          posts: extremes,
          limitation: "Lifetime counters are not age-normalized.",
        },
        recommendation: {
          title: "Review unusually strong or weak posts",
          titleVi: "Xem bài đăng nổi bật hoặc yếu bất thường",
          action: "publisher",
          details:
            "Compare format, length, posting time and topic before repeating a pattern.",
        },
      });
  }
  return out;
}
export async function generateInsights(
  pool: PgPool,
  businessId: string,
  channelId: string,
  now = new Date(),
) {
  const end = new Date(
    new Date(+now + 7 * 3600000).toISOString().slice(0, 10) + "T00:00:00+07:00",
  );
  const start = new Date(+end - 28 * 86400000),
    previousStart = new Date(+start - 28 * 86400000);
  const a = { businessId, channelScope: ["*"] };
  const [current, previous, repeat, posts] = await Promise.all([
    operations(pool, a, start, end, channelId),
    operations(pool, a, previousStart, start, channelId),
    pool.query(
      "SELECT v.id,count(m.id)::int AS count FROM conversation v JOIN message m ON m.conversation_id=v.id AND NOT m.from_business WHERE v.business_id=$1 AND v.channel_id=$2 AND v.status<>'resolved' AND m.sent_at>=$3 AND m.sent_at<$4 AND NOT EXISTS(SELECT 1 FROM reply_draft d JOIN reply_delivery x ON x.draft_id=d.id WHERE d.conversation_id=v.id AND x.status='sent') GROUP BY v.id HAVING count(m.id)>=2 LIMIT 100",
      [businessId, channelId, start, end],
    ),
    pool.query(
      "SELECT DISTINCT ON(object_id,metric) * FROM metric_snapshot WHERE business_id=$1 AND channel_id=$2 AND day>=$3::date ORDER BY object_id,metric,day DESC",
      [businessId, channelId, start],
    ),
  ]);
  const insights = [
    ...detectOperations(current, previous, repeat.rows),
    ...detectPosts(
      posts.rows.filter((r) => {
        const published = Date.parse(r.metadata?.publishedAt);
        return (
          Number.isFinite(published) && published >= +start && published < +end
        );
      }),
    ),
  ];
  for (const i of insights)
    await pool.query(
      "INSERT INTO insight(id,business_id,channel_id,detector,period_start,period_end,evidence,recommendation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        randomUUID(),
        businessId,
        channelId,
        i.detector,
        start,
        end,
        i.evidence,
        i.recommendation,
      ],
    );
  return insights.length;
}
