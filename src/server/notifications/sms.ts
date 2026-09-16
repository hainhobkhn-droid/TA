import { randomUUID } from "node:crypto";
import { transaction, type PgPool } from "../db/index.js";
import type { Config } from "../config.js";
import { audit } from "../audit/index.js";
export async function deliverSms(
  pool: PgPool,
  c: Config,
  fetcher: typeof fetch = fetch,
) {
  const rows = (
    await pool.query(
      "SELECT n.*,u.\"phoneNumber\",u.\"phoneNumberVerified\",m.revoked_at,m.channel_scope,p.digest_sms FROM notification n JOIN \"user\" u ON u.id=n.user_id JOIN membership m ON m.user_id=n.user_id AND m.business_id=n.business_id JOIN user_preference p ON p.user_id=n.user_id WHERE n.transport='sms' AND n.kind='weekly_digest' AND n.status='pending' LIMIT 20",
    )
  ).rows;
  for (const n of rows) {
    if (
      n.revoked_at ||
      !n.digest_sms ||
      !n.phoneNumberVerified ||
      !n.scope_snapshot ||
      (!n.channel_scope.includes("*") &&
        n.scope_snapshot.some((p: string) => !n.channel_scope.includes(p)))
    ) {
      await pool.query(
        "UPDATE notification SET status='cancelled' WHERE id=$1",
        [n.id],
      );
      continue;
    }
    const dry = c.HELPA_MODE === "dry_run" || c.NOTIFICATION_MODE === "dry_run";
    if (
      !dry &&
      (!c.TWILIO_MESSAGE_FROM || !c.TWILIO_ACCOUNT_SID || !c.TWILIO_AUTH_TOKEN)
    )
      continue;
    const claimed = await transaction(pool, async (db) => {
      const r = await db.query(
        "UPDATE notification SET status=$2 WHERE id=$1 AND status='pending' RETURNING id",
        [n.id, dry ? "would_have_sent" : "sending"],
      );
      if (!r.rowCount) return false;
      await audit(db, {
        businessId: n.business_id,
        actorType: "worker",
        action: dry
          ? "notification.would_have_sent"
          : "notification.attempt_started",
        payload: {
          notificationId: n.id,
          transport: "sms",
          kind: "weekly_digest",
        },
      });
      if (dry)
        await db.query(
          "INSERT INTO outbound_operation(id,business_id,operation_key,payload,mode,outcome) VALUES($1,$2,$3,$4,'dry_run','would_have_sent')",
          [
            randomUUID(),
            n.business_id,
            "sms:" + n.id,
            { notificationId: n.id, body: n.body, recipientUserId: n.user_id },
          ],
        );
      return true;
    });
    if (!claimed || dry) continue;
    try {
      const r = await fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(
                c.TWILIO_ACCOUNT_SID + ":" + c.TWILIO_AUTH_TOKEN,
              ).toString("base64"),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: n.phoneNumber,
            From: c.TWILIO_MESSAGE_FROM,
            Body: n.body,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      const result: any = await r.json();
      if (!r.ok || !result.sid) throw Error();
      await pool.query(
        "UPDATE notification SET status='provider_accepted',sent_at=now() WHERE id=$1",
        [n.id],
      );
    } catch {
      await pool.query(
        "UPDATE notification SET status='uncertain',error='SMS_OUTCOME_UNKNOWN' WHERE id=$1",
        [n.id],
      );
    }
  }
}
