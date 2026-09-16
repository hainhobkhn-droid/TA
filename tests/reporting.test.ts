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
const name = `helpa_reporting_${process.pid}_${Date.now()}`;
const url = new URL(adminUrl);
url.pathname = "/" + name;
const c = readConfig({
  DATABASE_URL: url.toString(),
  AUTH_SECRET: "publisher-auth-0123456789-0123456789",
  ENCRYPTION_KEY: "ab".repeat(32),
  BOOTSTRAP_TOKEN: "publisher-bootstrap-0123456789-0123456789",
  NODE_ENV: "test",
  META_APP_SECRET: "fixture-meta-secret",
  META_WEBHOOK_VERIFY_TOKEN: "fixture-verification",
  ANTHROPIC_API_KEY: "fixture-key",
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
});
afterAll(async () => {
  if (b) await b.app.close();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
});

import {
  collectMetrics,
  periodBounds,
  storeMetrics,
  operations,
  report,
} from "../src/server/metrics/service.js";
import {
  detectOperations,
  detectPosts,
  generateInsights,
} from "../src/server/advisor/service.js";
import { fetchTikTokMetrics } from "../src/server/channels/metrics.js";
import { ingestMessage, processInquiry } from "../src/server/inbox/service.js";
import { weeklyDigest } from "../src/server/notifications/digest.js";
import { deliverSms } from "../src/server/notifications/sms.js";
import { syncRows, currentKnowledge } from "../src/server/knowledge/service.js";
it("uses Vietnam today boundaries and matched previous durations", () => {
  const p = periodBounds(1, new Date("2026-09-09T05:00:00Z"));
  expect(p.start.toISOString()).toBe("2026-09-08T17:00:00.000Z");
  expect(+p.end - +p.start).toBe(+p.previousEnd - +p.previousStart);
});
it("reports empty data without inventing rates, conversions or audience history", async () => {
  const r = await request("GET", "/reports?days=28");
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().current).toMatchObject({
    inquiries: 0,
    replies_sent: 0,
    automation_rate: null,
    escalation_rate: null,
    first_response_seconds: null,
  });
  expect(r.json().snapshots).toEqual([]);
  expect(r.json().conversion).toMatchObject({ linkedOrders: 0, revenue: {} });
});
it("preserves immutable metric observations and filters unauthorized channels", async () => {
  const row = {
    objectId: "123",
    metric: "page_media_view",
    day: new Date().toISOString().slice(0, 10),
    period: "day",
    kind: "daily" as const,
    value: 42,
    source: "meta:fixture",
  };
  expect(await storeMetrics(b.pool, actor.businessId, channelId, [row])).toBe(
    1,
  );
  expect(
    await storeMetrics(b.pool, actor.businessId, channelId, [
      { ...row, value: 99 },
    ]),
  ).toBe(0);
  await expect(
    b.pool.query("UPDATE metric_snapshot SET value=100"),
  ).rejects.toThrow();
  const id = randomUUID();
  await b.pool.query(
    "INSERT INTO channel(id,business_id,platform,display_name,mode,status) VALUES($1,$2,'tiktok','Private TikTok','manual','manual')",
    [id, actor.businessId],
  );
  await storeMetrics(b.pool, actor.businessId, id, [
    { ...row, objectId: "secret", value: 100 },
  ]);
  const filtered = await report(
    b.pool,
    { businessId: actor.businessId, channelScope: ["facebook"] },
    28,
  );
  expect(filtered.snapshots.map((x: any) => x.object_id)).toEqual(["123"]);
});
it("treats TikTok counters as observations, preserves string IDs, and requests only granted capabilities", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "ok" },
          data: {
            videos: [
              {
                id: "9876543210987654321",
                create_time: 1788861600,
                title: "Fixture",
                view_count: 500,
                like_count: 20,
                share_count: 4,
                comment_count: 2,
              },
            ],
            has_more: false,
          },
        }),
      ),
  );
  const rows = await fetchTikTokMetrics(
    c,
    { external_id: "tt", granted_scopes: ["video.list"] },
    "fixture",
    fetcher as any,
  );
  expect(rows).toHaveLength(4);
  expect(rows[0]).toMatchObject({
    objectId: "9876543210987654321",
    kind: "cumulative",
    period: "lifetime_observed",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("counts a dry-run reply as simulated and leaves confirmed-response metrics empty", async () => {
  await b.pool.query("UPDATE business SET auto_replies_paused=false");
  const m = await ingestMessage(b.pool, {
    businessId: actor.businessId,
    channelId,
    threadId: "metric-thread",
    customerId: "metric-customer",
    externalId: "m1",
    kind: "manual",
    text: "Cảm ơn shop",
    sentAt: new Date().toISOString(),
  });
  await processInquiry(b.pool, c, m.messageId!, async () => ({
    language: "vi",
    intents: ["compliment"],
    confidence: 0.99,
    entities: {
      products: [],
      size: null,
      quantity: null,
      location: null,
      orderId: null,
      phone: null,
    },
  }));
  const r = await operations(
    b.pool,
    actor,
    new Date(Date.now() - 3600000),
    new Date(Date.now() + 1000),
  );
  expect(r).toMatchObject({
    inquiries: 1,
    manual_inquiries: 1,
    replies_sent: 0,
    simulated_replies: 1,
    response_sample_size: 0,
    first_response_seconds: null,
  });
});
it("requires enough evidence for posting advice and cites exact observed counts", () => {
  expect(detectPosts([])).toEqual([]);
  const rows = Array.from({ length: 10 }, (_, i) => ({
    object_id: String(i),
    metric: "view_count",
    value: i < 4 ? 500 : 100,
    metadata: {
      publishedAt: `2026-08-${String(i + 1).padStart(2, "0")}T${i < 4 ? "11" : "03"}:00:00Z`,
    },
  }));
  const result = detectPosts(rows);
  expect(
    result.find((x) => x.detector === "posting_hours")?.evidence,
  ).toMatchObject({
    windowStart: 18,
    windowEnd: 20,
    windowN: 4,
    windowAverage: 500,
    overallMedian: 100,
    ratio: 5,
    n: 10,
  });
  expect(
    detectOperations(
      { reasons: [], response_sample_size: 0 },
      { response_sample_size: 0 },
      [],
    ),
  ).toEqual([]);
});
it("applies a reviewed FAQ exactly once and keeps rules unchanged until review", async () => {
  const id = randomUUID();
  const content = {
    question_patterns: ["cách đặt hàng"],
    answer_vi: "Gửi mã sản phẩm và số lượng cho nhân viên.",
    answer_en: "Send the product code and quantity to staff.",
    intent: "how_to_order",
    rationale: "Human-reviewed fixture",
  };
  await b.pool.query(
    "INSERT INTO proposal(id,business_id,kind,content,evidence,created_by) VALUES($1,$2,'faq',$3,'{}',$4)",
    [id, actor.businessId, content, actor.userId],
  );
  expect(await currentKnowledge(b.pool, actor.businessId)).toEqual([]);
  const results = await Promise.all([
    request("POST", `/proposals/${id}/review`, { decision: "apply", content }),
    request("POST", `/proposals/${id}/review`, { decision: "apply", content }),
  ]);
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(
    (await currentKnowledge(b.pool, actor.businessId)).filter(
      (r) => r.dataset === "faq",
    ),
  ).toHaveLength(1);
  expect(
    (await b.pool.query("SELECT count(*) FROM rule_revision")).rows[0].count,
  ).toBe("0");
});
it("attributes an exact immutable order version once, using explicit product lines", async () => {
  const source = randomUUID();
  await b.pool.query(
    "INSERT INTO knowledge_source(id,business_id,name,kind,dataset) VALUES($1,$2,'Orders fixture','builtin','orders')",
    [source, actor.businessId],
  );
  await syncRows(b.pool, actor, source, [
    {
      order_id: "ORDER1",
      status: "paid",
      total: 500000,
      currency: "VND",
      lines: [
        { sku: "T20", quantity: 1, line_total: 320000 },
        { sku: "SQ", quantity: 1, line_total: 180000 },
      ],
      updated_at: new Date().toISOString(),
    },
  ]);
  const conv = (
    await b.pool.query(
      "SELECT id FROM conversation WHERE external_id='metric-thread'",
    )
  ).rows[0].id;
  const r = await request("POST", `/inbox/${conv}/order`, {
    orderId: "ORDER1",
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(
    (await request("POST", `/inbox/${conv}/order`, { orderId: "ORDER1" }))
      .statusCode,
  ).toBe(409);
  await syncRows(b.pool, actor, source, [
    {
      order_id: "ORDER1",
      status: "paid",
      total: 900000,
      currency: "VND",
      updated_at: new Date().toISOString(),
    },
  ]);
  const result = await report(b.pool, actor, 28);
  expect(result.conversion).toMatchObject({
    linkedOrders: 1,
    revenue: { VND: 500000 },
    products: { "T20 · VND": 320000, "SQ · VND": 180000 },
  });
});
it("weekly digest is opt-in, idempotent, and dry-run SMS invokes no transport", async () => {
  const monday = new Date("2026-09-14T01:00:00Z");
  await weeklyDigest(b.pool, c, monday);
  expect(
    (
      await b.pool.query(
        "SELECT count(*) FROM notification WHERE kind='weekly_digest'",
      )
    ).rows[0].count,
  ).toBe("0");
  await b.pool.query(
    "UPDATE user_preference SET digest_email=true WHERE user_id=$1",
    [actor.userId],
  );
  await weeklyDigest(b.pool, c, monday);
  await weeklyDigest(b.pool, c, monday);
  expect(
    (
      await b.pool.query(
        "SELECT count(*) FROM notification WHERE kind='weekly_digest'",
      )
    ).rows[0].count,
  ).toBe("1");
  const fetcher = vi.fn();
  await deliverSms(b.pool, c, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
});

it("collects Meta source metrics through the real database query without inventing missing fields", async () => {
  await b.pool.query(
    "UPDATE channel SET granted_scopes=ARRAY['read_insights','pages_read_engagement'],next_metrics_at=now() WHERE id=$1",
    [channelId],
  );
  const fetcher = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    const metric = u.pathname.split("/").at(-1);
    return new Response(
      JSON.stringify({
        data: [
          {
            name: metric,
            values: [
              {
                value: 31,
                end_time: new Date(Date.now() - 86400000).toISOString(),
              },
            ],
          },
        ],
      }),
    );
  });
  await collectMetrics(
    b.pool,
    { ...c, AUDIENCE_METRICS_ENABLED: true },
    fetcher as any,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  const rows = await b.pool.query(
    "SELECT * FROM metric_collection WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 1",
    [channelId],
  );
  expect(rows.rows[0]).toMatchObject({ status: "succeeded", rows: 3 });
});
it("rejects human-edited narratives with references outside the reviewed evidence", async () => {
  const id = randomUUID();
  await b.pool.query(
    "INSERT INTO proposal(id,business_id,kind,content,evidence,created_by) VALUES($1,$2,'narrative',$3,$4,$5)",
    [
      id,
      actor.businessId,
      { text: "Fixture", insightIds: [] },
      { insights: [] },
      actor.userId,
    ],
  );
  const r = await request("POST", `/proposals/${id}/review`, {
    decision: "apply",
    content: { text: "Edited", insightIds: [randomUUID()] },
  });
  expect(r.statusCode).toBe(400);
  expect(
    (await b.pool.query("SELECT status FROM proposal WHERE id=$1", [id]))
      .rows[0].status,
  ).toBe("pending");
});
