import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { transaction, type PgPool } from "../db/index.js";
import { audit } from "../audit/index.js";
export async function deliverEmails(
  pool: PgPool,
  c: Config,
  send?: (mail: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<unknown>,
) {
  const rows = await pool.query(
    "SELECT n.*,u.email,m.revoked_at,m.channel_scope,c.platform,p.digest_email FROM notification n JOIN \"user\" u ON u.id=n.user_id JOIN membership m ON m.user_id=n.user_id AND m.business_id=n.business_id LEFT JOIN channel c ON c.id=n.channel_id LEFT JOIN user_preference p ON p.user_id=n.user_id WHERE n.transport='email' AND n.status='pending' ORDER BY n.created_at LIMIT 20",
  );
  for (const n of rows.rows) {
    if (
      n.revoked_at ||
      (n.channel_id &&
        !n.channel_scope.includes("*") &&
        !n.channel_scope.includes(n.platform)) ||
      (n.kind === "weekly_digest" &&
        (!n.digest_email ||
          !n.scope_snapshot ||
          (!n.channel_scope.includes("*") &&
            n.scope_snapshot.some(
              (p: string) => !n.channel_scope.includes(p),
            ))))
    ) {
      await pool.query(
        "UPDATE notification SET status='recipient_revoked' WHERE id=$1",
        [n.id],
      );
      continue;
    }
    const dry = c.HELPA_MODE === "dry_run" || c.NOTIFICATION_MODE === "dry_run";
    if (!dry && !send && (!c.SMTP_HOST || !c.MAIL_FROM)) continue;
    const claimed = await transaction(pool, async (db) => {
      const r = await db.query(
        "UPDATE notification SET status=$2 WHERE id=$1 AND status='pending' RETURNING id",
        [n.id, dry ? "would_have_sent" : "sending"],
      );
      if (!r.rowCount) return false;
      await audit(db, {
        businessId: n.business_id,
        actorType: "worker",
        channelId: n.channel_id ?? undefined,
        action: dry
          ? "notification.would_have_sent"
          : "notification.attempt_started",
        payload: {
          notificationId: n.id,
          transport: "email",
          kind: n.kind,
          recipientUserId: n.user_id,
        },
      });
      if (dry)
        await db.query(
          "INSERT INTO outbound_operation(id,business_id,channel_id,operation_key,payload,mode,outcome) VALUES($1,$2,$3,$4,$5,'dry_run','would_have_sent')",
          [
            randomUUID(),
            n.business_id,
            n.channel_id,
            `email:${n.id}`,
            {
              notificationId: n.id,
              transport: "email",
              subject: n.subject,
              body: n.body,
              recipientUserId: n.user_id,
            },
          ],
        );
      return true;
    });
    if (!claimed || dry) continue;
    try {
      const mail = {
        to: n.email,
        subject: n.subject,
        text: `${n.body}\n\n${c.PUBLIC_URL}`,
      };
      if (send) await send(mail);
      else {
        const transporter = nodemailer.createTransport({
          host: c.SMTP_HOST,
          port: c.SMTP_PORT,
          secure: c.SMTP_SECURE,
          requireTLS: !c.SMTP_SECURE,
          auth: c.SMTP_USER
            ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD }
            : undefined,
          connectionTimeout: 10000,
          socketTimeout: 15000,
        });
        await transporter.sendMail({
          ...mail,
          from: c.MAIL_FROM,
          messageId: `<${n.id}@${new URL(c.PUBLIC_URL).hostname}>`,
        });
        transporter.close();
      }
      await pool.query(
        "UPDATE notification SET status='sent',sent_at=now() WHERE id=$1",
        [n.id],
      );
    } catch {
      await pool.query(
        "UPDATE notification SET status='uncertain',error='EMAIL_OUTCOME_UNKNOWN' WHERE id=$1",
        [n.id],
      );
    }
  }
}
