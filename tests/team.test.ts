import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import * as OTPAuth from "otpauth";
import { Pool } from "../src/server/db/index.js";
import { migrate } from "../src/server/db/migrate.js";
import { readConfig } from "../src/server/config.js";
import { buildApp } from "../src/server/app.js";
import { businessInstant, validatePublish } from "../src/shared/publishing.js";
import { dispatchVariant } from "../src/server/scheduler/dispatch.js";
import { encrypt } from "../src/server/channels/crypto.js";
import { facebookPublisher } from "../src/server/channels/facebook-publisher.js";
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://helpa:helpa-local-test@127.0.0.1:54329/helpa";
const name = `helpa_team_${process.pid}_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = "/" + name;
const c = readConfig({
  DATABASE_URL: url.toString(),
  AUTH_SECRET: "publisher-auth-0123456789-0123456789",
  ENCRYPTION_KEY: "ab".repeat(32),
  BOOTSTRAP_TOKEN: "publisher-bootstrap-0123456789-0123456789",
  NODE_ENV: "test",
  AUTH_DELIVERY_MODE: "console",
  AUTH_DEV_OUTBOX: `.local/team-outbox-${name}`,
  META_APP_SECRET: "fixture-meta-secret",
  META_WEBHOOK_VERIFY_TOKEN: "fixture-verification",
  ANTHROPIC_API_KEY: "fixture-key",
  LOG_LEVEL: "silent",
});
const smsCodes = new Map<string, string>();
const sms = {
  start: async (phone: string, code: string) => {
    smsCodes.set(phone, code);
  },
  check: async (phone: string, code: string) => smsCodes.get(phone) === code,
};
const admin = new Pool({ connectionString: adminUrl });
let b: Awaited<ReturnType<typeof buildApp>>;
let actor: any;
const jar = new Map<string, string>();
let channelId: string;
const assetId = randomUUID();
async function request(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: any,
) {
  const r = await b.app.inject({
    method,
    url: "/api" + path,
    headers: {
      origin: c.PUBLIC_URL,
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    ...(body ? { payload: body } : {}),
  });
  for (const v of r.cookies) jar.set(v.name, v.value);
  return r;
}
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  const p = new Pool({ connectionString: url.toString() });
  await migrate(p);
  await p.end();
  b = await buildApp(c, { serveWeb: false, sms });
  await b.app.ready();
  const boot = await request("POST", "/bootstrap", {
    token: c.BOOTSTRAP_TOKEN,
    email: "publisher@example.org",
    password: "publisher-password-123!",
    name: "Publisher owner",
    businessName: "Publisher fixture",
  });
  expect(boot.statusCode, boot.body).toBe(200);
  const setup = await request("POST", "/auth/two-factor/enable", {
    password: "publisher-password-123!",
  });
  const totp = OTPAuth.URI.parse(setup.json().totpURI) as OTPAuth.TOTP;
  const verified = await request("POST", "/auth/two-factor/verify-totp", {
    code: totp.generate(),
  });
  expect(verified.statusCode, verified.body).toBe(200);
  actor = (await request("GET", "/session")).json().actor;
  channelId = randomUUID();
  await b.pool.query(
    "INSERT INTO channel(id,business_id,platform,external_id,display_name,mode,status,credentials_encrypted,granted_scopes) VALUES($1,$2,'facebook','123','Fixture Facebook','dry_run','connected',$3,ARRAY['pages_manage_posts','pages_read_engagement'])",
    [
      channelId,
      actor.businessId,
      encrypt(
        { accessToken: "fixture" },
        `${actor.businessId}:channel:${channelId}`,
        c,
      ),
    ],
  );
});
afterAll(async () => {
  if (b) await b.app.close();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
});

import { readdir, readFile } from "node:fs/promises";
import { onDuty } from "../src/server/team/access.js";
import { csvCell } from "../src/server/audit/routes.js";
const phone = "+84912345678";
let delegateId: string;
const delegateJar = new Map<string, string>();
async function delegate(path: string, body?: any, method?: string) {
  const r = await b.app.inject({
    method: (method ?? (body ? "POST" : "GET")) as any,
    url: "/api" + path,
    headers: {
      origin: c.PUBLIC_URL,
      cookie: [...delegateJar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    ...(body ? { payload: body } : {}),
  });
  for (const x of r.cookies) delegateJar.set(x.name, x.value);
  return r;
}
it("invites a phone-only Facebook agent and accepts exactly one concurrent OTP redemption", async () => {
  const r = await request("POST", "/team/invitations", {
    name: "Sister fixture",
    kind: "phone",
    identity: phone,
    role: "agent",
    channelScope: ["facebook"],
    deniedPermissions: [],
  });
  expect(r.statusCode, r.body).toBe(200);
  delegateId = r.json().userId;
  expect(r.json().delivery).toBe("requested");
  const code = smsCodes.get(phone);
  expect(code).toHaveLength(6);
  const results = await Promise.all([
    delegate("/access/verify-phone", { phone, code }),
    delegate("/access/verify-phone", { phone, code }),
  ]);
  expect(results.filter((x) => x.statusCode === 200)).toHaveLength(1);
  expect((await delegate("/session")).json().actor).toMatchObject({
    role: "agent",
    channelScope: ["facebook"],
    mfaRequired: false,
  });
  expect((await delegate("/team")).statusCode).toBe(403);
  expect((await delegate("/channels/facebook/start", {})).statusCode).toBe(403);
});
it("allows only Facebook inbox and denies direct TikTok IDs", async () => {
  const tiktok = randomUUID();
  await b.pool.query(
    "INSERT INTO channel(id,business_id,platform,display_name,mode,status) VALUES($1,$2,'tiktok','Fixture TikTok','manual','manual')",
    [tiktok, actor.businessId],
  );
  const ok = await delegate("/inbox/manual", {
    channelId,
    customerId: "Customer",
    text: "Cảm ơn",
  });
  expect(ok.statusCode, ok.body).toBe(200);
  expect(
    (
      await delegate("/inbox/manual", {
        channelId: tiktok,
        customerId: "Customer",
        text: "Cảm ơn",
      })
    ).statusCode,
  ).toBe(403);
  const channelList = (await delegate("/channels")).json().channels;
  expect(channelList.some((x: any) => x.platform === "tiktok")).toBe(false);
  expect(
    (await delegate("/posts", { title: "Forbidden", variants: [] })).statusCode,
  ).not.toBe(200);
});
it("routes by Vietnam duty time and falls back to owner after revocation", async () => {
  const shift = await request("POST", "/team/duty", {
    slots: [
      {
        userId: delegateId,
        platform: "facebook",
        weekday: 3,
        startHour: 8,
        endHour: 17,
      },
    ],
  });
  expect(shift.statusCode, shift.body).toBe(200);
  expect(
    await onDuty(
      b.pool,
      actor.businessId,
      "facebook",
      new Date("2026-09-09T01:00:00Z"),
    ),
  ).toBe(delegateId);
  expect(
    await onDuty(
      b.pool,
      actor.businessId,
      "facebook",
      new Date("2026-09-09T10:00:00Z"),
    ),
  ).toBe(actor.userId);
  const revoke = await request("PATCH", "/team/members/" + delegateId, {
    role: "agent",
    channelScope: ["facebook"],
    deniedPermissions: [],
    revoke: true,
  });
  expect(revoke.statusCode, revoke.body).toBe(200);
  expect((await delegate("/inbox")).statusCode).toBe(401);
  expect(
    await onDuty(
      b.pool,
      actor.businessId,
      "facebook",
      new Date("2026-09-09T01:00:00Z"),
    ),
  ).toBe(actor.userId);
});
it("requires TOTP after a manager redeems a single-use email link, including passwordless enrollment", async () => {
  const r = await request("POST", "/team/invitations", {
    name: "Manager fixture",
    kind: "email",
    identity: "manager@example.org",
    role: "manager",
    channelScope: ["*"],
    deniedPermissions: [],
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().delivery).toBe("requested");
  const files = await readdir(c.AUTH_DEV_OUTBOX);
  const mail = (
    await Promise.all(
      files.map(async (f) =>
        JSON.parse(await readFile(c.AUTH_DEV_OUTBOX + "/" + f, "utf8")),
      ),
    )
  ).find((m) => m.email === "manager@example.org");
  const token = new URLSearchParams(new URL(mail.url).hash.slice(1)).get(
    "magic",
  );
  delegateJar.clear();
  const verified = await delegate("/access/verify-email", { token });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(
    (await delegate("/access/verify-email", { token })).statusCode,
  ).not.toBe(200);
  const session = (await delegate("/session")).json().actor;
  expect(session).toMatchObject({
    mfaRequired: true,
    mfaEnrolled: false,
    passwordAvailable: false,
  });
  expect((await delegate("/team")).statusCode).toBe(403);
  const setup = await delegate("/auth/two-factor/enable", {});
  expect(setup.statusCode, setup.body).toBe(200);
  const otp = OTPAuth.URI.parse(setup.json().totpURI) as OTPAuth.TOTP;
  expect(
    (await delegate("/auth/two-factor/verify-totp", { code: otp.generate() }))
      .statusCode,
  ).toBe(200);
  expect((await delegate("/team")).statusCode).toBe(200);
  expect(
    (
      await delegate("/team/invitations", {
        name: "No",
        kind: "email",
        identity: "other@example.org",
        role: "manager",
        channelScope: ["*"],
      })
    ).statusCode,
  ).toBe(403);
});
it("remote session revocation removes the session immediately and exposes no token", async () => {
  const r = await delegate("/sessions");
  expect(r.statusCode, r.body).toBe(200);
  expect(JSON.stringify(r.json())).not.toContain('"token"');
  const id = r.json().current;
  expect((await delegate("/sessions/" + id + "/revoke", {})).statusCode).toBe(
    200,
  );
  expect((await delegate("/inbox")).statusCode).toBe(401);
});
it("owner cannot be revoked and CSV neutralizes spreadsheet formulas", async () => {
  expect(
    (
      await request("PATCH", "/team/members/" + actor.userId, {
        role: "agent",
        channelScope: ["facebook"],
        deniedPermissions: [],
        revoke: true,
      })
    ).statusCode,
  ).toBe(403);
  expect(csvCell("=1+1")).toBe('"\'=1+1"');
  const csv = await request("GET", "/audit/export?actorId=" + actor.userId);
  expect(csv.statusCode, csv.body).toBe(200);
  expect(csv.headers["content-type"]).toContain("text/csv");
  expect(csv.body).toContain("invitation.created");
});

import { maintainChannels } from "../src/server/channels/maintenance.js";
import { decrypt } from "../src/server/channels/crypto.js";
it("keeps approval-only permissions subtractive and blocks manual inquiry writes", async () => {
  const p = "+84912345679";
  const invite = await request("POST", "/team/invitations", {
    name: "Approval only",
    kind: "phone",
    identity: p,
    role: "agent",
    channelScope: ["facebook"],
    deniedPermissions: ["replies.write"],
  });
  expect(invite.statusCode, invite.body).toBe(200);
  delegateJar.clear();
  expect(
    (
      await delegate("/access/verify-phone", {
        phone: p,
        code: smsCodes.get(p),
      })
    ).statusCode,
  ).toBe(200);
  expect((await delegate("/inbox")).statusCode).toBe(200);
  expect(
    (
      await delegate("/inbox/manual", {
        channelId,
        customerId: "No",
        text: "No",
      })
    ).statusCode,
  ).toBe(403);
});
it("rotates TikTok access and refresh tokens without returning or auditing secrets", async () => {
  const id = randomUUID();
  const old = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    refreshExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  };
  await b.pool.query(
    "INSERT INTO channel(id,business_id,platform,external_id,display_name,mode,status,credentials_encrypted,token_expires_at) VALUES($1,$2,'tiktok','open-fixture','Token fixture','dry_run','connected',$3,now()+interval '1 hour')",
    [
      id,
      actor.businessId,
      encrypt(old, `${actor.businessId}:channel:${id}`, c),
    ],
  );
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          open_id: "open-fixture",
          access_token: "new-access",
          refresh_token: "new-refresh",
          scope: "video.upload",
          expires_in: 86400,
          refresh_expires_in: 2592000,
        }),
      ),
  );
  await maintainChannels(
    b.pool,
    { ...c, TIKTOK_CLIENT_KEY: "fixture", TIKTOK_CLIENT_SECRET: "fixture" },
    fetcher as any,
  );
  const row = (await b.pool.query("SELECT * FROM channel WHERE id=$1", [id]))
    .rows[0];
  expect(
    decrypt(row.credentials_encrypted, `${actor.businessId}:channel:${id}`, c),
  ).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  expect(row.token_checked_at).toBeTruthy();
  expect((await request("GET", "/channels")).body).not.toMatch(
    /new-access|new-refresh/,
  );
  expect((await request("GET", "/audit")).body).not.toMatch(
    /new-access|new-refresh/,
  );
});
