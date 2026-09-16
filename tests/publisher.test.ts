import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
const name = `helpa_publisher_${process.pid}_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = "/" + name;
const c = readConfig({
  DATABASE_URL: url.toString(),
  AUTH_SECRET: "publisher-auth-0123456789-0123456789",
  ENCRYPTION_KEY: "ab".repeat(32),
  BOOTSTRAP_TOKEN: "publisher-bootstrap-0123456789-0123456789",
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
});
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
const scheduledAt = "2026-09-09T11:00:00.000Z";
function variant(format = "text") {
  return {
    channelId,
    format,
    caption: "Hàng mới về",
    hashtags: ["#haisan"],
    firstComment: "",
    mediaIds: format === "reel" ? [assetId] : [],
    scheduledAt,
  };
}
async function create(format = "text") {
  const r = await request("POST", "/posts", {
    title: "Fixture post",
    variants: [variant(format)],
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().variants[0] as string;
}
async function approve(id: string, revision = 1) {
  const r = await request("POST", `/posts/${id}/approve`, { revision });
  expect(r.statusCode, r.body).toBe(200);
}
async function row(id: string) {
  return (await b.pool.query("SELECT * FROM post_variant WHERE id=$1", [id]))
    .rows[0];
}
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  const p = new Pool({ connectionString: url.toString() });
  await migrate(p);
  await p.end();
  b = await buildApp(c, { serveWeb: false });
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
  await b.pool.query(
    "INSERT INTO media_asset(id,business_id,uploaded_by,name,scope,storage_key,sha256,bytes,mime,status,metadata) VALUES($1::uuid,$2,$3,'fixture.mp4',ARRAY['facebook'],$1::text,$4,123,'video/mp4','ready',$5)",
    [
      assetId,
      actor.businessId,
      actor.userId,
      "cd".repeat(32),
      { width: 540, height: 960, duration: 10, codec: "h264", fps: 30 },
    ],
  );
});
afterAll(async () => {
  if (b) await b.app.close();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
});
it("converts Vietnam wall time independently of host or user zone and rejects invalid dates", () => {
  expect(businessInstant("2026-09-09T18:00")).toBe(scheduledAt);
  expect(() => businessInstant("2026-02-30T18:00")).toThrow();
});
it("does not publish early or without approval; exact Reel payload is recorded once at its UTC due instant", async () => {
  const id = await create("reel");
  const send = vi.fn();
  await dispatchVariant(b.pool, c, id, new Date(scheduledAt), () => ({
    publish: send,
  }));
  expect((await row(id)).status).toBe("scheduled");
  await approve(id);
  await dispatchVariant(
    b.pool,
    c,
    id,
    new Date("2026-09-09T10:59:59Z"),
    () => ({ publish: send }),
  );
  expect((await row(id)).status).toBe("scheduled");
  await dispatchVariant(b.pool, c, id, new Date(scheduledAt), () => ({
    publish: send,
  }));
  await dispatchVariant(b.pool, c, id, new Date(scheduledAt), () => ({
    publish: send,
  }));
  expect(send).not.toHaveBeenCalled();
  const r = await row(id);
  expect(r.status).toBe("would_have_sent");
  expect(r.platform_id).toBeNull();
  const ops = await b.pool.query(
    "SELECT * FROM outbound_operation WHERE operation_key=$1",
    [`post:${id}:r1`],
  );
  expect(ops.rowCount).toBe(1);
  expect(ops.rows[0].payload).toMatchObject({
    scheduledAt,
    format: "reel",
    businessTimezone: "Asia/Ho_Chi_Minh",
    media: [{ id: assetId, sha256: "cd".repeat(32) }],
  });
});
it("edits invalidate approval and stale approval requests fail", async () => {
  const id = await create();
  await approve(id);
  const edit = await request("PATCH", "/posts/" + id, {
    expectedRevision: 1,
    variant: { ...variant(), caption: "New revision" },
  });
  expect(edit.statusCode).toBe(200);
  const r = await row(id);
  expect(r.approved_revision).toBeNull();
  expect(
    (await request("POST", `/posts/${id}/approve`, { revision: 1 })).statusCode,
  ).toBe(409);
  await dispatchVariant(b.pool, c, id, new Date(scheduledAt));
  expect((await row(id)).status).toBe("scheduled");
});
it("rejects media that does not meet the chosen format before scheduling", async () => {
  const r = await request("POST", "/posts", {
    title: "Invalid image",
    variants: [{ ...variant(), format: "photo" }],
  });
  expect(r.statusCode).toBe(400);
  expect(r.json().error).toBe("PHOTO_REQUIRES_ONE_IMAGE");
});
it("blocks a revoked approver even when the revision remains approved", async () => {
  const id = await create();
  const mid = "manager-" + randomUUID();
  await b.pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
    mid,
    "Fixture manager",
    mid + "@example.org",
  ]);
  await b.pool.query(
    "INSERT INTO membership(id,business_id,user_id,role,channel_scope,revoked_at) VALUES($1,$2,$3,'manager',ARRAY['facebook'],now())",
    [randomUUID(), actor.businessId, mid],
  );
  await b.pool.query(
    "UPDATE post_variant SET approved_revision=1,approved_by=$2 WHERE id=$1",
    [id, mid],
  );
  await dispatchVariant(b.pool, c, id, new Date(scheduledAt));
  expect((await row(id)).status).toBe("scheduled");
});
it("persists audit before a live mutation and never retries an ambiguous external effect", async () => {
  const id = await create();
  await approve(id);
  await b.pool.query("UPDATE channel SET mode='live' WHERE id=$1", [channelId]);
  const send = vi.fn(async () => {
    throw new Error("connection dropped after send");
  });
  const factory = (step: any) => ({
    publish: async (p: any) => {
      await step("publish", { body: { message: p.caption } }, send);
      return { outcome: "published" as const, platformId: "fixture-id" };
    },
  });
  await dispatchVariant(
    b.pool,
    { ...c, HELPA_MODE: "live" },
    id,
    new Date(scheduledAt),
    factory,
  );
  await dispatchVariant(
    b.pool,
    { ...c, HELPA_MODE: "live" },
    id,
    new Date(scheduledAt),
    factory,
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect((await row(id)).status).toBe("needs_action");
  const a = await b.pool.query(
    "SELECT 1 FROM audit_event WHERE action='publish.attempt_started' AND payload->>'variantId'=$1",
    [id],
  );
  expect(a.rowCount).toBe(1);
  await b.pool.query("UPDATE channel SET mode='dry_run' WHERE id=$1", [
    channelId,
  ]);
});
it("audit persistence failure prevents the platform mutation", async () => {
  const id = await create();
  await approve(id);
  await b.pool.query("UPDATE channel SET mode='live' WHERE id=$1", [channelId]);
  await b.pool.query(
    "CREATE FUNCTION publisher_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publish.attempt_started' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER publisher_reject BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION publisher_reject_audit();",
  );
  const send = vi.fn(async () => ({ id: "must-not-send" }));
  await dispatchVariant(
    b.pool,
    { ...c, HELPA_MODE: "live" },
    id,
    new Date(scheduledAt),
    (step) => ({
      publish: async () => {
        await step("publish", {}, send);
        return { outcome: "published" };
      },
    }),
  );
  expect(send).not.toHaveBeenCalled();
  await b.pool.query(
    "DROP TRIGGER publisher_reject ON audit_event; DROP FUNCTION publisher_reject_audit()",
  );
  await b.pool.query("UPDATE channel SET mode='dry_run' WHERE id=$1", [
    channelId,
  ]);
});
it("expands recurring posts in Vietnam time, all requiring independent approval", async () => {
  const r = await request("POST", "/recurring", {
    title: "Friday arrivals",
    variants: [variant()],
    weekday: 5,
    localTime: "18:00",
    weeks: 3,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().count).toBe(3);
  const p = await b.pool.query(
    "SELECT v.scheduled_at,v.approved_revision FROM recurring_occurrence o JOIN post_variant v ON v.post_id=o.post_id WHERE o.template_id=$1",
    [r.json().id],
  );
  expect(
    p.rows.every(
      (v) =>
        new Date(v.scheduled_at).getUTCHours() === 11 &&
        new Date(v.scheduled_at).getUTCDay() === 5 &&
        v.approved_revision === null,
    ),
  ).toBe(true);
});
it("uses documented text and first-comment requests with separate steps (synthetic contract)", async () => {
  const calls: any[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    calls.push([String(url), JSON.parse(init.body)]);
    return new Response(
      JSON.stringify({ id: calls.length === 1 ? "123_456" : "comment-1" }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const names: string[] = [];
  const p: any = {
    ...variant(),
    platform: "facebook",
    pageId: "123",
    media: [],
    firstComment: "https://example.org",
    businessTimezone: "Asia/Ho_Chi_Minh",
  };
  const r = await facebookPublisher(
    c,
    { accessToken: "fixture" },
    async (name, payload, send) => {
      names.push(name);
      return send();
    },
    async () => "",
    fetcher,
  ).publish(p);
  expect(names).toEqual(["publish", "first_comment"]);
  expect(calls[0][0]).toContain("/v25.0/123/feed");
  expect(calls[1][0]).toContain("/123_456/comments");
  expect(calls[0][1].message).toBe("Hàng mới về\n#haisan");
  expect(r.permalink).toBe("https://www.facebook.com/123_456");
});

it("keeps resumable upload IDs on Meta's host and waits for Reel publication confirmation", async () => {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: any, init: any) => {
    requests.push(String(url));
    if (init.body?.pipe) {
      for await (const _chunk of init.body) {
        /* Consume the local fixture stream. */
      }
    }
    return new Response(
      JSON.stringify(
        String(url).includes("/upload:")
          ? { h: "fixture-handle" }
          : { id: "123_789" },
      ),
    );
  }) as any;
  const step = async (
    name: string,
    _payload: unknown,
    send: () => Promise<any>,
  ) => (name === "video:start" ? { id: "upload:fixture_123=" } : send());
  const p: any = {
    ...variant("video"),
    platform: "facebook",
    pageId: "123",
    media: [{ id: assetId, bytes: 123, mime: "video/mp4" }],
  };
  await facebookPublisher(
    c,
    { accessToken: "fixture", userAccessToken: "fixture-user" },
    step,
    async () => "config/rules.example.yaml",
    fetcher,
  ).publish(p);
  expect(new URL(requests[0]).hostname).toBe("graph.facebook.com");
  expect(new URL(requests[0]).pathname).toBe("/v25.0/upload:fixture_123=");
  expect(new URL(requests[1]).hostname).toBe("graph-video.facebook.com");
  const reelStep = async (
    name: string,
    _payload: unknown,
    _send: () => Promise<any>,
  ) =>
    name === "reel:start"
      ? {
          video_id: "1234",
          upload_url: "https://rupload.facebook.com/video-upload/1234",
        }
      : { success: true };
  const status = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: {
            processing_phase: { status: "completed" },
            publishing_phase: {
              status: "in_progress",
              publish_status: "draft",
            },
          },
        }),
      ),
  ) as any;
  const r = await facebookPublisher(
    c,
    { accessToken: "fixture" },
    reelStep as any,
    async () => "",
    status,
  ).publish({ ...p, format: "reel" });
  expect(r).toMatchObject({
    outcome: "needs_action",
    platformId: "1234",
    reason: "META_REEL_PUBLISHING_PENDING",
  });
  expect(status).toHaveBeenCalledTimes(2);
});
it("rejects untrusted upstream object IDs before first-comment dispatch", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: "https://untrusted.invalid/token" })),
  ) as any;
  await expect(
    facebookPublisher(
      c,
      { accessToken: "fixture" },
      async (_n, _p, send) => send(),
      async () => "",
      fetcher,
    ).publish({
      ...variant(),
      platform: "facebook",
      pageId: "123",
      media: [],
      firstComment: "Hello",
    } as any),
  ).rejects.toThrow("EXTERNAL_OUTCOME_UNKNOWN");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
