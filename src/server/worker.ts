import { collectMetrics } from "./metrics/service.js";
import { weeklyDigest } from "./notifications/digest.js";
import { deliverSms } from "./notifications/sms.js";
import { maintainChannels, reconcileTikTok } from "./channels/maintenance.js";
import { pollSources } from "./knowledge/google.js";
import { deliverEmails } from "./notifications/service.js";
import { readConfig } from "./config.js";
import { Pool } from "./db/index.js";
import { startQueue, probeQueue } from "./queue.js";
import { recordDryRun } from "./channels/dispatch.js";

import { processInquiry, dispatchReply } from "./inbox/service.js";
import { processWebhooks } from "./inbox/routes.js";
import { dispatchVariant } from "./scheduler/dispatch.js";
import { inspectMedia, makeReel } from "./media/service.js";
import { can } from "../shared/permissions.js";
const c = readConfig();
const pool = new Pool({ connectionString: c.DATABASE_URL, max: 6 });
const boss = await startQueue(c);
type Probe = {
  businessId: string;
  actorId: string;
  operationKey: string;
  payload: unknown;
};
await boss.work<Probe>(probeQueue, { localConcurrency: 1 }, async (jobs) => {
  for (const job of jobs) await recordDryRun(pool, c, job.data);
});
await boss.work<any>(
  "helpa-media-rendition",
  { localConcurrency: 1 },
  async (jobs) => {
    for (const job of jobs) {
      const a = (
        await pool.query(
          "SELECT * FROM membership WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL",
          [job.data.businessId, job.data.actorId],
        )
      ).rows[0];
      const m = (
        await pool.query(
          "SELECT * FROM media_asset WHERE business_id=$1 AND id=$2",
          [job.data.businessId, job.data.assetId],
        )
      ).rows[0];
      if (
        !a ||
        !m ||
        m.scope.some(
          (p: string) =>
            !can(
              a.role,
              a.channel_scope,
              "posts.write",
              p,
              a.denied_permissions,
            ),
        )
      )
        continue;
      await makeReel(pool, c, m, {
        businessId: a.business_id,
        userId: a.user_id,
      } as any);
    }
  },
);
let ticking = false;
async function workPending() {
  if (ticking) return;
  ticking = true;
  try {
    const pending = await pool.query(
      "SELECT id FROM post_variant WHERE status IN ('scheduled','publishing') AND scheduled_at<=now() ORDER BY scheduled_at LIMIT 20",
    );
    for (const v of pending.rows) await dispatchVariant(pool, c, v.id);
    const media = await pool.query(
      "SELECT id FROM media_asset WHERE status='processing' ORDER BY created_at LIMIT 5",
    );
    for (const m of media.rows) await inspectMedia(pool, c, m.id);
  } finally {
    ticking = false;
  }
}
const workTimer = setInterval(
  () =>
    void workPending().catch(() =>
      console.error('{"event":"worker_tick_failed"}'),
    ),
  5000,
);
let inboxTicking = false;
async function inboxWork() {
  if (inboxTicking) return;
  inboxTicking = true;
  try {
    await pool.query(
      "UPDATE reply_delivery SET status='uncertain',error='WORKER_INTERRUPTED' WHERE status='started' AND created_at<now()-interval '2 minutes'",
    );
    await pool.query(
      "UPDATE reply_draft SET status='needs_approval',checks=jsonb_set(checks,'{reasons}',coalesce(checks->'reasons','[]')||'\"EXTERNAL_OUTCOME_UNKNOWN\"'::jsonb) WHERE status='sending' AND EXISTS(SELECT 1 FROM reply_delivery x WHERE x.draft_id=reply_draft.id AND x.status='uncertain')",
    );
    await processWebhooks(pool);
    const messages = await pool.query(
      "SELECT id FROM message WHERE processed_at IS NULL AND NOT from_business ORDER BY received_at LIMIT 10",
    );
    for (const m of messages.rows) await processInquiry(pool, c, m.id);
    const drafts = await pool.query(
      "SELECT id FROM reply_draft WHERE status IN ('queued','approved') ORDER BY created_at LIMIT 20",
    );
    for (const d of drafts.rows) await dispatchReply(pool, c, d.id, "reply");
    const holding = await pool.query(
      "SELECT d.id FROM reply_draft d WHERE d.status='needs_approval' AND NOT EXISTS(SELECT 1 FROM reply_delivery x WHERE x.draft_id=d.id AND x.kind='holding') LIMIT 20",
    );
    for (const d of holding.rows) await dispatchReply(pool, c, d.id, "holding");
    await deliverEmails(pool, c);
  } finally {
    inboxTicking = false;
  }
}
const inboxTimer = setInterval(
  () =>
    void inboxWork().catch(() =>
      console.error('{"event":"inbox_worker_failed"}'),
    ),
  2000,
);
async function heartbeat() {
  await pool.query(
    "INSERT INTO system_heartbeat(name,last_seen_at,details) VALUES('worker',now(),$1) ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at,details=excluded.details",
    [JSON.stringify({ mode: c.HELPA_MODE })],
  );
  await pool.query("DELETE FROM oauth_state WHERE expires_at<now()");
  await pool.query("DELETE FROM oauth_selection WHERE expires_at<now()");
  await pool.query("DELETE FROM login_limit WHERE resets_at<now()");
}
let sourceTicking = false;
const sourceTimer = setInterval(() => {
  if (sourceTicking) return;
  sourceTicking = true;
  void (async () => {
    await pollSources(pool, c);
    await maintainChannels(pool, c);
    await reconcileTikTok(pool, c);
    await collectMetrics(pool, c);
    await weeklyDigest(pool, c);
    await deliverSms(pool, c);
  })()
    .catch(() => console.error('{"event":"source_poll_failed"}'))
    .finally(() => {
      sourceTicking = false;
    });
}, 60000);
await heartbeat();
const timer = setInterval(
  () =>
    void heartbeat().catch(() => console.error('{"event":"heartbeat_failed"}')),
  15000,
);
console.log(JSON.stringify({ event: "worker_started", mode: c.HELPA_MODE }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(workTimer);
  clearInterval(inboxTimer);
  clearInterval(sourceTimer);
  while (ticking || inboxTicking || sourceTicking)
    await new Promise((r) => setTimeout(r, 100));
  await boss.stop();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
