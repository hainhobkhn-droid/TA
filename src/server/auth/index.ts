import {
  smsProvider,
  sendMagic,
  eligible,
  hashIdentity,
  type SmsProvider,
} from "../team/access.js";
import { transaction } from "../db/index.js";
import { betterAuth } from "better-auth";
import { twoFactor, magicLink, phoneNumber } from "better-auth/plugins";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import type { PgPool } from "../db/index.js";
import type { Config } from "../config.js";
import { can, type Role, type Permission } from "../../shared/permissions.js";
import { AppError } from "../errors.js";

export function createAuth(
  pool: PgPool,
  c: Config,
  sms: SmsProvider = smsProvider(c, pool),
) {
  return betterAuth({
    appName: "Helpa",
    baseURL: c.PUBLIC_URL,
    secret: c.AUTH_SECRET,
    database: pool,
    trustedOrigins: [c.PUBLIC_URL],
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 30,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: c.PUBLIC_URL.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    plugins: [
      magicLink({
        disableSignUp: true,
        expiresIn: 600,
        storeToken: "hashed",
        sendMagicLink: async ({ email, token }) => {
          if (await eligible(pool, email.toLowerCase(), "email"))
            await sendMagic(c, email, token);
        },
      }),
      phoneNumber({
        requireVerification: true,
        phoneNumberValidator: (p) => /^\+84[35789]\d{8}$/.test(p),
        sendOTP: async ({ phoneNumber: p, code }) => {
          if (!(await eligible(pool, p, "phone")))
            throw new AppError(403, "INVITATION_REQUIRED");
          await pool.query(
            "INSERT INTO phone_challenge(identity_hash,expires_at) VALUES($1,now()+interval '10 minutes') ON CONFLICT(identity_hash) DO UPDATE SET expires_at=excluded.expires_at,attempts=0,code_hash=NULL",
            [hashIdentity(p)],
          );
          await sms.start(p, code);
        },
        verifyOTP: async ({ phoneNumber: p, code }) =>
          transaction(pool, async (db) => {
            const r = (
              await db.query(
                "SELECT * FROM phone_challenge WHERE identity_hash=$1 AND expires_at>now() AND attempts<5 FOR UPDATE",
                [hashIdentity(p)],
              )
            ).rows[0];
            if (!r || !(await eligible(pool, p, "phone"))) return false;
            await db.query(
              "UPDATE phone_challenge SET attempts=attempts+1 WHERE identity_hash=$1",
              [hashIdentity(p)],
            );
            const ok = await sms.check(p, code);
            if (ok)
              await db.query(
                "DELETE FROM phone_challenge WHERE identity_hash=$1",
                [hashIdentity(p)],
              );
            return ok;
          }),
      }),
      twoFactor({
        issuer: "Helpa",
        allowPasswordless: true,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
export type Actor = {
  userId: string;
  sessionId: string;
  businessId: string;
  role: Role;
  channelScope: string[];
  deniedPermissions: string[];
  passwordAvailable: boolean;
  name: string;
  email: string;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  locale: "vi" | "en";
  timezone: string;
};
export async function actorFor(
  auth: Auth,
  pool: PgPool,
  req: FastifyRequest,
  allowPending = false,
): Promise<Actor> {
  const s = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (!s) throw new AppError(401, "UNAUTHENTICATED");
  const result = await pool.query(
    `SELECT m.business_id,m.role,m.channel_scope,m.denied_permissions,p.locale,p.timezone,
    EXISTS(SELECT 1 FROM account WHERE "userId"=m.user_id AND password IS NOT NULL) AS password_available,
    EXISTS(SELECT 1 FROM mfa_session WHERE session_id=$2) AS mfa_verified
    FROM membership m LEFT JOIN user_preference p ON p.user_id=m.user_id
    WHERE m.user_id=$1 AND m.revoked_at IS NULL`,
    [s.user.id, s.session.id],
  );
  if (!result.rowCount) throw new AppError(403, "MEMBERSHIP_REVOKED");
  const m = result.rows[0];
  const mfaRequired =
    (m.role === "owner" || m.role === "manager" || !!s.user.twoFactorEnabled) &&
    (!s.user.twoFactorEnabled || !m.mfa_verified);
  if (mfaRequired && !allowPending) throw new AppError(403, "MFA_REQUIRED");
  return {
    userId: s.user.id,
    sessionId: s.session.id,
    businessId: m.business_id,
    role: m.role,
    channelScope: m.channel_scope,
    deniedPermissions: m.denied_permissions,
    passwordAvailable: m.password_available,
    name: s.user.name,
    email: s.user.email,
    mfaRequired,
    mfaEnrolled: !!s.user.twoFactorEnabled,
    locale: m.locale ?? "vi",
    timezone: m.timezone ?? "Asia/Ho_Chi_Minh",
  };
}
export function requirePermission(
  actor: Actor,
  permission: Permission,
  channel?: string,
) {
  if (
    !can(
      actor.role,
      actor.channelScope,
      permission,
      channel,
      actor.deniedPermissions,
    )
  )
    throw new AppError(403, "FORBIDDEN");
}
