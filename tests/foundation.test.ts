import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as OTPAuth from "otpauth";
import { Pool, transaction, type PgPool } from "../src/server/db/index.js";
import { migrate } from "../src/server/db/migrate.js";
import { readConfig } from "../src/server/config.js";
import { buildApp } from "../src/server/app.js";
import { recordDryRun } from "../src/server/channels/dispatch.js";
import { decrypt, encrypt } from "../src/server/channels/crypto.js";
import { probeQueue } from "../src/server/queue.js";

// Uses an isolated database on a local Postgres, never a platform account or paid API.
const adminUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://helpa:helpa-local-test@127.0.0.1:54329/helpa";
const dbName = `helpa_test_${process.pid}_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const c = readConfig({
  DATABASE_URL: url.toString(),
  AUTH_SECRET: "fixture-auth-secret-0123456789-0123456789",
  ENCRYPTION_KEY: "ab".repeat(32),
  BOOTSTRAP_TOKEN: "fixture-bootstrap-token-0123456789-0123456789",
  NODE_ENV: "test",
  META_APP_ID: "123",
  META_APP_SECRET: "fixture-meta-secret",
  LOG_LEVEL: "silent",
});
let admin: PgPool;
let built: Awaited<ReturnType<typeof buildApp>>;
let businessId: string;
let ownerId: string;
let totp: OTPAuth.TOTP;
let backupCodes: string[] = [];
const discovered = [
  {
    id: "456",
    name: "Fixture Seafood Page",
    accessToken: "fixture-page-token-DO-NOT-EXPOSE",
    userAccessToken: "fixture-user-token-DO-NOT-EXPOSE",
    tasks: ["CREATE_CONTENT"],
    scopes: ["pages_show_list"],
    expiresAt: null,
    expiryKind: "no_scheduled_expiry" as const,
  },
];
const discover = vi.fn().mockResolvedValue(discovered);
class Browser {
  cookies = new Map<string, string>();
  async request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await built.app.inject({
      method,
      url,
      headers: {
        origin: c.PUBLIC_URL,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...extra,
      },
      ...(body === undefined ? {} : { payload: body as any }),
    });
    for (const cookie of response.cookies) {
      if (cookie.value) this.cookies.set(cookie.name, cookie.value);
      else this.cookies.delete(cookie.name);
    }
    return response;
  }
}
const owner = new Browser();
beforeAll(async () => {
  admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const pool = new Pool({ connectionString: c.DATABASE_URL });
  await migrate(pool);
  await pool.end();
  built = await buildApp(c, {
    serveWeb: false,
    facebook: {
      authorizationUrl: (state) =>
        `https://www.facebook.com/dialog/oauth?state=${state}`,
      discover,
    },
  });
  await built.app.ready();
});
afterAll(async () => {
  if (built) await built.app.close();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
});
describe("foundation vertical slice", () => {
  it("rejects public registration and an untrusted origin", async () => {
    expect(
      (
        await owner.request("POST", "/api/auth/sign-up/email", {
          email: "a@example.org",
          password: "ignored",
          name: "attacker",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await owner.request(
          "POST",
          "/api/bootstrap",
          {},
          { origin: "https://evil.example" },
        )
      ).statusCode,
    ).toBe(403);
  });
  it("bootstraps exactly one owner and blocks all business access before MFA", async () => {
    const body = {
      token: c.BOOTSTRAP_TOKEN,
      email: "owner@example.org",
      password: "fixture-password-123!",
      name: "Dio",
      businessName: "Fixture seafood",
    };
    const r = await owner.request("POST", "/api/bootstrap", body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).not.toHaveProperty("token");
    const s = (await owner.request("GET", "/api/session")).json();
    expect(s.actor.mfaRequired).toBe(true);
    businessId = s.actor.businessId;
    ownerId = s.actor.userId;
    for (const route of [
      "/api/settings",
      "/api/channels",
      "/api/audit",
      "/api/system",
    ])
      expect((await owner.request("GET", route)).json().error).toBe(
        "MFA_REQUIRED",
      );
    expect(
      (await owner.request("POST", "/api/bootstrap", body)).statusCode,
    ).toBe(409);
  });
  it("enrolls and verifies TOTP with an audited MFA session", async () => {
    const enable = await owner.request("POST", "/api/auth/two-factor/enable", {
      password: "fixture-password-123!",
    });
    expect(enable.statusCode, enable.body).toBe(200);
    const body = enable.json();
    expect(body.totpURI).toContain("otpauth://");
    backupCodes = body.backupCodes;
    totp = OTPAuth.URI.parse(body.totpURI) as OTPAuth.TOTP;
    const verify = await owner.request(
      "POST",
      "/api/auth/two-factor/verify-totp",
      { code: totp.generate() },
    );
    expect(verify.statusCode, verify.body).toBe(200);
    expect(
      (await owner.request("GET", "/api/session")).json().actor.mfaRequired,
    ).toBe(false);
    const settings = await owner.request("GET", "/api/settings");
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json().business.coverage).toBe("24/7/365");
    expect(settings.json().business.complaint_notification).toBe("email");
    expect(settings.json().business.llm_monthly_cap_usd).toBe("0.00");
  });
  it("requires a challenge again on login and prohibits trusted-device bypass", async () => {
    await owner.request("POST", "/api/auth/sign-out", {});
    const signin = await owner.request("POST", "/api/auth/sign-in/email", {
      email: "owner@example.org",
      password: "fixture-password-123!",
    });
    expect(signin.json().twoFactorRedirect).toBe(true);
    expect((await owner.request("GET", "/api/channels")).statusCode).toBe(401);
    expect(
      (
        await owner.request("POST", "/api/auth/two-factor/verify-totp", {
          code: totp.generate(),
          trustDevice: true,
        })
      ).statusCode,
    ).toBe(400);
    // Use a recovery code here to avoid reusing the enrollment TOTP time step.
    const verify = await owner.request(
      "POST",
      "/api/auth/two-factor/verify-backup-code",
      { code: backupCodes[0] },
    );
    expect(verify.statusCode, verify.body).toBe(200);
    expect((await owner.request("GET", "/api/settings")).statusCode).toBe(200);
  });
  it("updates configurable providers/caps and rejects a lost settings update", async () => {
    const before = (await owner.request("GET", "/api/settings")).json()
      .business;
    const body = {
      version: before.settings_version,
      name: before.name,
      autoRepliesPaused: true,
      postsRequireApproval: true,
      llmProvider: "openai",
      llmModel: "configured-later",
      llmMonthlyCapUsd: 12.5,
    };
    expect(
      (await owner.request("PATCH", "/api/settings", body)).statusCode,
    ).toBe(200);
    expect(
      (await owner.request("PATCH", "/api/settings", body)).statusCode,
    ).toBe(409);
    const after = (await owner.request("GET", "/api/settings")).json();
    expect(after.business.llm_provider).toBe("openai");
    expect(after.business.llm_monthly_cap_usd).toBe("12.50");
    expect(after.llmExecutionAvailable).toBe(true);
  });
  it("binds OAuth state to the session and consumes it once", async () => {
    const started = await owner.request(
      "POST",
      "/api/channels/facebook/start",
      {},
    );
    expect(started.statusCode, started.body).toBe(200);
    const state = new URL(started.json().url).searchParams.get("state");
    const other = new Browser();
    expect(
      (
        await other.request(
          "GET",
          `/api/channels/facebook/callback?state=${state}&code=fixture`,
        )
      ).statusCode,
    ).toBe(401);
    const callback = await owner.request(
      "GET",
      `/api/channels/facebook/callback?state=${state}&code=fixture`,
    );
    expect(callback.statusCode, callback.body).toBe(302);
    expect(
      (
        await owner.request(
          "GET",
          `/api/channels/facebook/callback?state=${state}&code=fixture`,
        )
      ).statusCode,
    ).toBe(400);
    expect(discover).toHaveBeenCalledTimes(1);
  });
  it("keeps Page selection and stored credentials encrypted and out of browser/audit responses", async () => {
    const pending = await owner.request(
      "GET",
      "/api/channels/facebook/pending",
    );
    expect(pending.body).not.toContain(discovered[0].accessToken);
    expect(pending.body).not.toContain(discovered[0].userAccessToken);
    expect(pending.json().pages[0].name).toBe(discovered[0].name);
    const select = await owner.request(
      "POST",
      "/api/channels/facebook/select",
      { selection: pending.json().selection, pageId: "456" },
    );
    expect(select.statusCode, select.body).toBe(200);
    const rows = await built.pool.query(
      "SELECT * FROM channel WHERE business_id=$1 AND platform='facebook'",
      [businessId],
    );
    const row = rows.rows[0];
    expect(JSON.stringify(row)).not.toContain(discovered[0].accessToken);
    expect(
      decrypt(row.credentials_encrypted, `${businessId}:channel:${row.id}`, c),
    ).toEqual({
      accessToken: discovered[0].accessToken,
      userAccessToken: discovered[0].userAccessToken,
    });
    for (const route of [
      "/api/channels",
      "/api/audit",
      "/api/settings",
      "/api/system",
    ]) {
      const r = await owner.request("GET", route);
      expect(r.body).not.toContain(discovered[0].accessToken);
      expect(r.body).not.toContain(discovered[0].userAccessToken);
      expect(r.body).not.toContain(c.META_APP_SECRET);
      expect(r.body).not.toContain("credentials_encrypted");
    }
  });
  it("enqueues atomically, processes a diagnostic once and stores its exact payload", async () => {
    const response = await owner.request(
      "POST",
      "/api/system/dry-run-probe",
      {},
    );
    expect(response.statusCode, response.body).toBe(200);
    const jobs = await built.boss.fetch<{
      businessId: string;
      actorId: string;
      operationKey: string;
      payload: unknown;
    }>(probeQueue);
    expect(jobs.length).toBe(1);
    const result = await recordDryRun(built.pool, c, jobs[0].data);
    expect(result.outcome).toBe("would_have_sent");
    await built.boss.complete(probeQueue, jobs[0].id);
    expect((await recordDryRun(built.pool, c, jobs[0].data)).duplicate).toBe(
      true,
    );
    const ops = await built.pool.query(
      "SELECT payload FROM outbound_operation WHERE business_id=$1 AND operation_key=$2",
      [businessId, response.json().operationKey],
    );
    expect(ops.rows).toEqual([
      {
        payload: {
          kind: "foundation_diagnostic",
          message: "Helpa dry-run check",
          businessTimezone: "Asia/Ho_Chi_Minh",
        },
      },
    ]);
    expect(discover).not.toHaveBeenCalled();
  });
  it("rolls back outbound intent if auditing fails and refuses the diagnostic in live mode", async () => {
    await built.pool.query(
      `CREATE FUNCTION test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_reject_audit()`,
    );
    const input = {
      businessId,
      actorId: ownerId,
      operationKey: randomUUID(),
      payload: { message: "not sent" },
    };
    try {
      await expect(recordDryRun(built.pool, c, input)).rejects.toThrow(
        "fixture audit failure",
      );
      expect(
        (
          await built.pool.query(
            "SELECT 1 FROM outbound_operation WHERE operation_key=$1",
            [input.operationKey],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await built.pool.query(
        "DROP TRIGGER test_audit_failure ON audit_event; DROP FUNCTION test_reject_audit()",
      );
    }
    await expect(
      recordDryRun(built.pool, { ...c, HELPA_MODE: "live" }, input),
    ).rejects.toThrow("DRY_RUN_REQUIRED");
  });
  it("does not leave a queued job behind after a transaction rollback", async () => {
    const key = randomUUID();
    await expect(
      transaction(built.pool, async (db) => {
        await built.boss.send(
          probeQueue,
          { businessId, operationKey: key },
          { db: { executeSql: (text, values) => db.query(text, values) } },
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      (
        await built.pool.query(
          "SELECT 1 FROM pgboss.job WHERE data->>'operationKey'=$1",
          [key],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("enforces channel scope and membership revocation on an existing session", async () => {
    const created = await built.auth.api.signUpEmail({
      body: {
        email: "viewer@example.org",
        name: "Viewer",
        password: "fixture-viewer-pass!",
      },
    });
    await built.pool.query(
      "INSERT INTO membership(id,business_id,user_id,role,channel_scope) VALUES($1,$2,$3,'viewer',ARRAY['facebook'])",
      [randomUUID(), businessId, created.user.id],
    );
    const viewer = new Browser();
    await viewer.request("POST", "/api/auth/sign-in/email", {
      email: "viewer@example.org",
      password: "fixture-viewer-pass!",
    });
    const channels = (await viewer.request("GET", "/api/channels")).json()
      .channels;
    expect(channels.length).toBe(1);
    expect(channels[0].platform).toBe("facebook");
    expect(
      (await viewer.request("POST", "/api/channels/facebook/start", {}))
        .statusCode,
    ).toBe(403);
    expect(
      (await viewer.request("POST", "/api/system/dry-run-probe", {}))
        .statusCode,
    ).toBe(403);
    await built.pool.query(
      "UPDATE membership SET revoked_at=now() WHERE user_id=$1",
      [created.user.id],
    );
    expect((await viewer.request("GET", "/api/channels")).json().error).toBe(
      "MEMBERSHIP_REVOKED",
    );
  });
  it("protects owner membership and append-only audit rows", async () => {
    await expect(
      built.pool.query("UPDATE membership SET role='viewer' WHERE user_id=$1", [
        ownerId,
      ]),
    ).rejects.toThrow("Owner cannot be removed");
    await expect(
      built.pool.query("DELETE FROM audit_event WHERE business_id=$1", [
        businessId,
      ]),
    ).rejects.toThrow("append-only");
  });
  it("disconnect removes the credential and records the action", async () => {
    const row = (
      await built.pool.query(
        "SELECT id FROM channel WHERE business_id=$1 AND platform='facebook'",
        [businessId],
      )
    ).rows[0];
    expect(
      (await owner.request("POST", `/api/channels/${row.id}/disconnect`, {}))
        .statusCode,
    ).toBe(200);
    const after = (
      await built.pool.query(
        "SELECT credentials_encrypted,status FROM channel WHERE id=$1",
        [row.id],
      )
    ).rows[0];
    expect(after).toEqual({
      credentials_encrypted: null,
      status: "disconnected",
    });
    expect(
      (
        await owner.request("GET", "/api/audit?action=channel.disconnected")
      ).json().events,
    ).toHaveLength(1);
  });
  it("rotates an encrypted Page credential through the offline operator command", async () => {
    const row = (
      await built.pool.query(
        "SELECT id FROM channel WHERE business_id=$1 AND platform='facebook'",
        [businessId],
      )
    ).rows[0];
    const context = `${businessId}:channel:${row.id}`;
    await built.pool.query(
      "UPDATE channel SET credentials_encrypted=$1 WHERE id=$2",
      [
        JSON.stringify(
          encrypt({ accessToken: "rotation-fixture" }, context, c),
        ),
        row.id,
      ],
    );
    const next = {
      ...c,
      ENCRYPTION_KEY: "ef".repeat(32),
      ENCRYPTION_KEY_ID: "v2",
    };
    const baseEnv = {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(c).map(([key, value]) => [key, String(value)]),
      ),
    };
    const rotated = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/server/channels/rotate-key.ts",
        "--confirm-key-rotation",
      ],
      {
        env: {
          ...baseEnv,
          NEXT_ENCRYPTION_KEY: next.ENCRYPTION_KEY,
          NEXT_ENCRYPTION_KEY_ID: next.ENCRYPTION_KEY_ID,
        },
      },
    );
    expect(rotated.stdout).not.toContain(next.ENCRYPTION_KEY);
    const stored = (
      await built.pool.query(
        "SELECT credentials_encrypted FROM channel WHERE id=$1",
        [row.id],
      )
    ).rows[0].credentials_encrypted;
    expect(decrypt(stored, context, next)).toEqual({
      accessToken: "rotation-fixture",
    });
    expect(() => decrypt(stored, context, c)).toThrow();
    expect(
      (
        await built.pool.query(
          "SELECT 1 FROM audit_event WHERE action='credentials.key_rotated' AND business_id=$1",
          [businessId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("offline owner recovery revokes sessions and requires new MFA enrollment", async () => {
    const env = {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(c).map(([key, value]) => [key, String(value)]),
      ),
    };
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/server/auth/recover-owner.ts",
        "--confirm-owner-mfa-reset",
      ],
      { env },
    );
    expect((await owner.request("GET", "/api/settings")).statusCode).toBe(401);
    const signin = await owner.request("POST", "/api/auth/sign-in/email", {
      email: "owner@example.org",
      password: "fixture-password-123!",
    });
    expect(signin.statusCode).toBe(200);
    expect(
      (await owner.request("GET", "/api/session")).json().actor.mfaRequired,
    ).toBe(true);
    expect((await owner.request("GET", "/api/settings")).json().error).toBe(
      "MFA_REQUIRED",
    );
    expect(
      (
        await built.pool.query(
          "SELECT 1 FROM audit_event WHERE action='auth.owner_mfa_reset' AND business_id=$1",
          [businessId],
        )
      ).rowCount,
    ).toBe(1);
  });
});
