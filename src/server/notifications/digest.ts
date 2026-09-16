import { randomUUID } from "node:crypto";
import { transaction, type PgPool } from "../db/index.js";
import { audit } from "../audit/index.js";
import type { Config } from "../config.js";
import { operations } from "../metrics/service.js";
import { generateInsights } from "../advisor/service.js";
export async function weeklyDigest(pool: PgPool, c: Config, now = new Date()) {
  const local = new Date(+now + 7 * 3600000);
  if (local.getUTCDay() !== 1 || local.getUTCHours() < 8) return;
  const end = new Date(local.toISOString().slice(0, 10) + "T00:00:00+07:00");
  const start = new Date(+end - 7 * 86400000),
    prior = new Date(+start - 7 * 86400000);
  const users = (
    await pool.query(
      'SELECT m.*,p.digest_email,p.digest_sms,u.email,u."phoneNumber" FROM membership m JOIN user_preference p ON p.user_id=m.user_id JOIN "user" u ON u.id=m.user_id WHERE m.revoked_at IS NULL AND (p.digest_email OR p.digest_sms)',
    )
  ).rows;
  for (const u of users) {
    const key = "digest:" + end.toISOString();
    if (
      (
        await pool.query(
          "SELECT 1 FROM notification WHERE business_id=$1 AND user_id=$2 AND dedup_key=$3",
          [u.business_id, u.user_id, key],
        )
      ).rowCount
    )
      continue;
    const actor = { businessId: u.business_id, channelScope: u.channel_scope };
    const current = await operations(pool, actor, start, end),
      previous = await operations(pool, actor, prior, start);
    const fields = [
      "inquiries",
      "replies_sent",
      "automated_sent",
      "escalations",
      "unanswered",
      "first_response_seconds",
      "resolution_seconds",
    ];
    const top = fields
      .filter(
        (k) =>
          typeof (current as any)[k] === "number" &&
          typeof (previous as any)[k] === "number",
      )
      .map((k) => ({
        metric: k,
        current: (current as any)[k],
        previous: (previous as any)[k],
        change: (current as any)[k] - (previous as any)[k],
      }))
      .sort(
        (a, b) =>
          Math.abs(b.change) / Math.max(1, Math.abs(b.previous)) -
          Math.abs(a.change) / Math.max(1, Math.abs(a.previous)),
      )
      .slice(0, 5);
    const channels = (
      await pool.query(
        "SELECT id FROM channel WHERE business_id=$1 AND ($2 OR platform=ANY($3::text[]))",
        [u.business_id, u.channel_scope.includes("*"), u.channel_scope],
      )
    ).rows;
    for (const ch of channels)
      await generateInsights(pool, u.business_id, ch.id, end);
    const insights = (
      await pool.query(
        "SELECT DISTINCT ON(i.detector,i.channel_id) i.* FROM insight i JOIN channel c ON c.id=i.channel_id WHERE i.business_id=$1 AND ($2 OR c.platform=ANY($3::text[])) AND i.status='open' ORDER BY i.detector,i.channel_id,i.period_end DESC",
        [u.business_id, u.channel_scope.includes("*"), u.channel_scope],
      )
    ).rows.slice(0, 5);
    let body =
      `Helpa · ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}\n` +
      top
        .map(
          (x) =>
            `${x.metric}: ${Number(x.current.toFixed(1))} (previous ${Number(x.previous.toFixed(1))}, change ${Number(x.change.toFixed(1))})`,
        )
        .join("\n") +
      "\n\n" +
      (insights.length
        ? insights
            .map(
              (i) =>
                `${i.recommendation.title}\n${i.recommendation.details}\nEvidence ${i.id}: ${JSON.stringify(i.evidence)}`,
            )
            .join("\n\n")
        : "Insufficient evidence for recommendations.");
    if (u.channel_scope.includes("*")) {
      const approved = (
        await pool.query(
          "SELECT id,content FROM proposal WHERE business_id=$1 AND kind='narrative' AND status='applied' AND reviewed_at>=$2 AND reviewed_at<$3 ORDER BY reviewed_at DESC LIMIT 1",
          [u.business_id, start, end],
        )
      ).rows[0];
      if (approved)
        body +=
          "\n\nHuman-approved narrative / Tổng kết đã duyệt (" +
          approved.id +
          "):\n" +
          approved.content.text;
    }
    await transaction(pool, async (db) => {
      let created = 0;
      for (const transport of [
        ...(u.digest_email && !u.email.endsWith("@phone.invalid")
          ? ["email"]
          : []),
        ...(u.digest_sms && u.phoneNumber ? ["sms"] : []),
      ])
        created +=
          (
            await db.query(
              "INSERT INTO notification(id,business_id,user_id,kind,transport,subject,body,dedup_key,scope_snapshot) VALUES($1,$2,$3,'weekly_digest',$4,'Helpa weekly digest',$5,$6,$7) ON CONFLICT DO NOTHING",
              [
                randomUUID(),
                u.business_id,
                u.user_id,
                transport,
                transport === "sms"
                  ? `${top.map((x) => `${x.metric}: ${Number(x.current.toFixed(1))} (${x.change >= 0 ? "+" : ""}${Number(x.change.toFixed(1))})`).join("; ")}. ${insights.length} insights: ${c.PUBLIC_URL}`
                  : body,
                key,
                u.channel_scope,
              ],
            )
          ).rowCount ?? 0;
      if (created)
        await audit(db, {
          businessId: u.business_id,
          actorType: "worker",
          action: "digest.created",
          payload: {
            userId: u.user_id,
            periodStart: start,
            periodEnd: end,
            transports: created,
          },
        });
    });
  }
}
