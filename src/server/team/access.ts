import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { AppError } from "../errors.js";
import type { Config } from "../config.js";
import { transaction, type PgPool } from "../db/index.js";
import { audit } from "../audit/index.js";
import { can } from "../../shared/permissions.js";
export const hashIdentity = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export interface SmsProvider {
  start(phone: string, code: string): Promise<void>;
  check(phone: string, code: string): Promise<boolean>;
}
export function smsProvider(c: Config, pool: PgPool): SmsProvider {
  async function call(path: string, body: Record<string, string>) {
    if (
      !c.TWILIO_ACCOUNT_SID ||
      !c.TWILIO_AUTH_TOKEN ||
      !c.TWILIO_VERIFY_SERVICE_SID
    )
      throw new AppError(409, "TWILIO_NOT_CONFIGURED");
    const r = await fetch(
      `https://verify.twilio.com/v2/Services/${c.TWILIO_VERIFY_SERVICE_SID}/${path}`,
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
        body: new URLSearchParams(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw new AppError(502, "TWILIO_VERIFICATION_FAILED");
    return r.json() as Promise<any>;
  }
  return {
    async start(phone, code) {
      if (c.AUTH_DELIVERY_MODE === "live") {
        await call("Verifications", { To: phone, Channel: "sms" });
        return;
      }
      if (c.AUTH_DELIVERY_MODE !== "console" || c.NODE_ENV === "production")
        throw new AppError(409, "AUTH_DELIVERY_DISABLED");
      await pool.query(
        "UPDATE phone_challenge SET code_hash=$2 WHERE identity_hash=$1",
        [hashIdentity(phone), hashIdentity(code)],
      );
      await devDelivery(c, { phone, code });
    },
    async check(phone, code) {
      if (c.AUTH_DELIVERY_MODE === "live") {
        const r = await call("VerificationCheck", { To: phone, Code: code });
        return r.status === "approved" && r.valid === true;
      }
      if (c.AUTH_DELIVERY_MODE !== "console" || c.NODE_ENV === "production")
        return false;
      const r = (
        await pool.query(
          "SELECT code_hash FROM phone_challenge WHERE identity_hash=$1",
          [hashIdentity(phone)],
        )
      ).rows[0];
      return (
        !!r?.code_hash &&
        timingSafeEqual(
          Buffer.from(r.code_hash),
          Buffer.from(hashIdentity(code)),
        )
      );
    },
  };
}
export async function devDelivery(c: Config, payload: unknown) {
  if (c.NODE_ENV === "production") throw new AppError(409, "CONSOLE_DISABLED");
  await mkdir(c.AUTH_DEV_OUTBOX, { recursive: true, mode: 0o700 });
  await writeFile(
    `${c.AUTH_DEV_OUTBOX}/${randomUUID()}.json`,
    JSON.stringify(payload),
    { mode: 0o600 },
  );
}
export async function sendMagic(c: Config, email: string, token: string) {
  const url = `${c.PUBLIC_URL}/#magic=${encodeURIComponent(token)}`;
  if (c.AUTH_DELIVERY_MODE === "console" && c.NODE_ENV !== "production") {
    await devDelivery(c, { email, url });
    return;
  }
  if (c.AUTH_DELIVERY_MODE !== "live" || !c.SMTP_HOST || !c.MAIL_FROM)
    throw new AppError(409, "AUTH_DELIVERY_DISABLED");
  const t = nodemailer.createTransport({
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
  try {
    await t.sendMail({
      from: c.MAIL_FROM,
      to: email,
      subject: "Helpa · Sign in / Đăng nhập",
      text: `Open this single-use link within 10 minutes.\nMở liên kết một lần này trong 10 phút.\n\n${url}`,
    });
  } finally {
    t.close();
  }
}
export async function eligible(
  pool: PgPool,
  identity: string,
  kind: "email" | "phone",
) {
  const r = await pool.query(
    `SELECT u.id FROM "user" u WHERE ${kind === "phone" ? 'u."phoneNumber"' : "lower(u.email)"}=$1 AND (EXISTS(SELECT 1 FROM membership m WHERE m.user_id=u.id AND m.revoked_at IS NULL) OR EXISTS(SELECT 1 FROM invitation i WHERE i.user_id=u.id AND i.status='pending' AND i.expires_at>now()))`,
    [identity],
  );
  return r.rows[0]?.id as string | undefined;
}
export async function acceptInvitation(pool: PgPool, userId: string) {
  return transaction(pool, async (db) => {
    const i = (
      await db.query(
        "SELECT i.* FROM invitation i JOIN \"user\" u ON u.id=i.user_id WHERE i.user_id=$1 AND i.status='pending' AND i.expires_at>now() AND ((i.kind='email' AND u.\"emailVerified\") OR (i.kind='phone' AND u.\"phoneNumberVerified\")) FOR UPDATE OF i",
        [userId],
      )
    ).rows[0];
    if (!i) return;
    const inviter = (
      await db.query(
        "SELECT * FROM membership WHERE user_id=$1 AND business_id=$2 AND revoked_at IS NULL",
        [i.invited_by, i.business_id],
      )
    ).rows[0];
    if (
      !inviter ||
      !["owner", "manager"].includes(inviter.role) ||
      (inviter.role === "manager" &&
        (i.role === "manager" ||
          (!inviter.channel_scope.includes("*") &&
            i.channel_scope.some(
              (p: string) => !inviter.channel_scope.includes(p),
            ))))
    )
      throw new AppError(403, "INVITER_AUTHORITY_CHANGED");
    const existing = (
      await db.query(
        "SELECT role FROM membership WHERE user_id=$1 AND business_id=$2 FOR UPDATE",
        [userId, i.business_id],
      )
    ).rows[0];
    if (existing?.role === "owner") throw new AppError(403, "OWNER_PROTECTED");
    await db.query(
      "INSERT INTO membership(id,business_id,user_id,role,channel_scope,denied_permissions) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(business_id,user_id) DO UPDATE SET role=excluded.role,channel_scope=excluded.channel_scope,denied_permissions=excluded.denied_permissions,revoked_at=NULL",
      [
        randomUUID(),
        i.business_id,
        userId,
        i.role,
        i.channel_scope,
        i.denied_permissions,
      ],
    );
    await db.query(
      "INSERT INTO user_preference(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [userId],
    );
    await db.query(
      "UPDATE invitation SET status='accepted',accepted_at=now() WHERE id=$1",
      [i.id],
    );
    await audit(db, {
      businessId: i.business_id,
      actorId: userId,
      action: "invitation.accepted",
      payload: {
        invitationId: i.id,
        role: i.role,
        channelScope: i.channel_scope,
      },
    });
  });
}
export async function onDuty(
  pool: Pick<PgPool, "query">,
  businessId: string,
  platform: string,
  now = new Date(),
) {
  const local = new Date(+now + 7 * 3600000);
  const day = local.getUTCDay(),
    hour = local.getUTCHours();
  const candidates = (
    await pool.query(
      "SELECT m.* FROM duty_slot d JOIN membership m ON m.user_id=d.user_id AND m.business_id=d.business_id WHERE d.business_id=$1 AND d.platform=$2 AND d.weekday=$3 AND d.start_hour<=$4 AND d.end_hour>$4 AND m.revoked_at IS NULL ORDER BY d.start_hour",
      [businessId, platform, day, hour],
    )
  ).rows;
  const found = candidates.find(
    (m) =>
      can(
        m.role,
        m.channel_scope,
        "replies.write",
        platform,
        m.denied_permissions,
      ) &&
      can(
        m.role,
        m.channel_scope,
        "approvals.write",
        platform,
        m.denied_permissions,
      ),
  );
  return (
    found?.user_id ??
    (
      await pool.query(
        "SELECT user_id FROM membership WHERE business_id=$1 AND role='owner' AND revoked_at IS NULL",
        [businessId],
      )
    ).rows[0].user_id
  );
}
