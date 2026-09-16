import { onDuty } from "../team/access.js";
import { randomUUID } from "node:crypto";
import { transaction, type PgPool, type PoolClient } from "../db/index.js";
import type { Config } from "../config.js";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
import { understand, type Analysis } from "../llm/gateway.js";
import { currentKnowledge } from "../knowledge/service.js";
import { loadRules, defaultVoice } from "../rules/service.js";
import { runEngine, fallbackAnalysis, factsFresh } from "./engine.js";
import { can } from "../../shared/permissions.js";
import { effectiveMode } from "../channels/dispatch.js";
import { decrypt } from "../channels/crypto.js";
import { channelAdapter, type ReplySender } from "../channels/adapter.js";
export async function ingestMessage(
  db: Pick<PgPool | PoolClient, "query">,
  input: {
    businessId: string;
    channelId: string;
    threadId: string;
    customerId: string;
    externalId: string;
    kind: string;
    text: string;
    sentAt: string;
    fromBusiness?: boolean;
    attachments?: unknown[];
  },
) {
  if (
    !Number.isFinite(Date.parse(input.sentAt)) ||
    Date.parse(input.sentAt) > Date.now() + 60000
  )
    throw new AppError(400, "INVALID_MESSAGE_TIME");
  const id = randomUUID();
  const own = !!input.fromBusiness;
  const conv = (
    await db.query(
      "INSERT INTO conversation(id,business_id,channel_id,external_id,customer_id,kind,last_customer_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(channel_id,external_id) DO UPDATE SET last_customer_at=greatest(conversation.last_customer_at,excluded.last_customer_at),status=CASE WHEN excluded.last_customer_at>conversation.last_customer_at THEN 'open' ELSE conversation.status END RETURNING id",
      [
        id,
        input.businessId,
        input.channelId,
        input.threadId,
        input.customerId,
        input.kind,
        own ? null : input.sentAt,
      ],
    )
  ).rows[0].id;
  const messageId = randomUUID();
  const r = await db.query(
    "INSERT INTO message(id,business_id,conversation_id,external_id,text,from_business,attachments,sent_at,processed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(conversation_id,external_id) DO NOTHING RETURNING id",
    [
      messageId,
      input.businessId,
      conv,
      input.externalId,
      input.text,
      own,
      JSON.stringify(input.attachments ?? []),
      input.sentAt,
      own ? new Date() : null,
    ],
  );
  return {
    conversationId: conv,
    messageId: r.rows[0]?.id ?? null,
    duplicate: !r.rowCount,
  };
}
export async function processInquiry(
  pool: PgPool,
  c: Config,
  messageId: string,
  classifier?: (text: string) => Promise<Analysis>,
) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
        [`inquiry:${messageId}`],
      )
    ).rows[0].ok;
    if (!locked) return;
    const m = (
      await pool.query(
        "SELECT m.*,c.channel_id FROM message m JOIN conversation c ON c.id=m.conversation_id WHERE m.id=$1 AND m.processed_at IS NULL AND NOT m.from_business",
        [messageId],
      )
    ).rows[0];
    if (!m) return;
    let analysis: Analysis;
    let providerReason: string | undefined;
    let callId: string | undefined;
    try {
      if (classifier) analysis = await classifier(m.text);
      else {
        const result = await understand(
          pool,
          c,
          m.business_id,
          m.channel_id,
          m.text,
        );
        analysis = result.data;
        callId = result.callId;
      }
    } catch (e) {
      analysis = fallbackAnalysis(m.text);
      providerReason = e instanceof AppError ? e.code : "LLM_UNAVAILABLE";
    }
    const { rules, version } = await loadRules(pool, m.business_id);
    const voice = (
      await pool.query("SELECT * FROM voice_profile WHERE business_id=$1", [
        m.business_id,
      ])
    ).rows[0];
    const result = runEngine(
      m.text,
      analysis,
      await currentKnowledge(pool, m.business_id),
      rules,
      voice?.config ?? defaultVoice,
    );
    if (providerReason) result.checks.reasons.push(providerReason);
    const id = randomUUID();
    await transaction(pool, async (db) => {
      const inserted = await db.query(
        "INSERT INTO reply_draft(id,business_id,message_id,conversation_id,text,holding_text,analysis,facts,checks,autonomy,status,rule_version,voice_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(message_id) DO NOTHING RETURNING id",
        [
          id,
          m.business_id,
          messageId,
          m.conversation_id,
          result.text,
          result.holdingText,
          {
            ...result.analysis,
            callId,
            provider: classifier
              ? "fixture"
              : providerReason
                ? "offline_fallback"
                : "llm",
          },
          JSON.stringify(result.facts),
          result.checks,
          result.autonomy,
          result.autonomy === "auto_send"
            ? "queued"
            : result.autonomy === "none"
              ? "ignored"
              : "needs_approval",
          version,
          voice?.version ?? 0,
        ],
      );
      if (!inserted.rowCount) return;
      await db.query("UPDATE message SET processed_at=now() WHERE id=$1", [
        messageId,
      ]);
      if (
        result.autonomy === "draft_for_approval" ||
        result.autonomy === "human_only"
      ) {
        const channel = (
          await db.query("SELECT platform FROM channel WHERE id=$1", [
            m.channel_id,
          ])
        ).rows[0];
        const owner = {
          user_id: await onDuty(db as any, m.business_id, channel.platform),
        };
        await db.query("UPDATE conversation SET assigned_to=$2 WHERE id=$1", [
          m.conversation_id,
          owner.user_id,
        ]);
        const complaint = result.analysis.intents.includes("complaint");
        const dutyUser = (
          await db.query('SELECT email FROM "user" WHERE id=$1', [
            owner.user_id,
          ])
        ).rows[0];
        const emailRecipient =
          complaint || dutyUser.email.endsWith("@phone.invalid")
            ? (
                await db.query(
                  "SELECT user_id FROM membership WHERE business_id=$1 AND role='owner' AND revoked_at IS NULL",
                  [m.business_id],
                )
              ).rows[0].user_id
            : owner.user_id;
        for (const transport of complaint ? ["email"] : ["email", "in_app"])
          await db.query(
            "INSERT INTO notification(id,business_id,user_id,channel_id,kind,transport,subject,body,dedup_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
            [
              randomUUID(),
              m.business_id,
              transport === "email" ? emailRecipient : owner.user_id,
              m.channel_id,
              complaint ? "complaint" : "approval",
              transport,
              complaint
                ? "Helpa: complaint needs a human"
                : "Helpa: reply needs review",
              `Open Helpa Inbox. ${result.checks.reasons.join(", ")}`,
              `draft:${id}`,
            ],
          );
      }
      await audit(db, {
        businessId: m.business_id,
        actorType: "worker",
        channelId: m.channel_id,
        action: "inquiry.processed",
        payload: {
          messageId,
          draftId: id,
          ruleVersion: version,
          voiceVersion: voice?.version ?? 0,
          analysis: result.analysis,
          facts: result.facts,
          checks: result.checks,
          callId,
        },
      });
    });
    if (result.autonomy === "auto_send")
      await dispatchReply(pool, c, id, "reply");
    else if (rules.holding_reply && result.autonomy !== "none")
      await dispatchReply(pool, c, id, "holding");
    return { id, ...result };
  } finally {
    if (locked)
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `inquiry:${messageId}`,
      ]);
    lock.release();
  }
}
export function messageWindowOpen(
  kind: string,
  lastCustomerAt: string | null,
  now = new Date(),
) {
  return (
    kind !== "messenger" ||
    (!!lastCustomerAt &&
      Date.parse(lastCustomerAt) <= +now &&
      +now - Date.parse(lastCustomerAt) < 24 * 3600000)
  );
}
export async function dispatchReply(
  pool: PgPool,
  c: Config,
  draftId: string,
  kind: "reply" | "holding",
  now = new Date(),
  sender?: ReplySender,
) {
  const lock = await pool.connect();
  let locked = false;
  try {
    const lookup = (
      await pool.query("SELECT conversation_id FROM reply_draft WHERE id=$1", [
        draftId,
      ])
    ).rows[0];
    if (!lookup) return;
    locked = (
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
        [`reply:${lookup.conversation_id}`],
      )
    ).rows[0].ok;
    if (!locked) return;
    const d = (
      await pool.query(
        "SELECT d.*,v.kind AS conversation_kind,v.customer_id,v.external_id AS thread_external_id,v.last_customer_at,v.channel_id,c.platform,c.external_id AS page_id,c.mode,c.status AS channel_status,c.credentials_encrypted,c.granted_scopes,c.token_expires_at,b.auto_replies_paused FROM reply_draft d JOIN conversation v ON v.id=d.conversation_id JOIN channel c ON c.id=v.channel_id JOIN business b ON b.id=d.business_id WHERE d.id=$1",
        [draftId],
      )
    ).rows[0];
    if (!d || (kind === "reply" && !["queued", "approved"].includes(d.status)))
      return;
    if ((kind === "holding" || !d.approved_by) && d.auto_replies_paused) return;
    if (kind === "reply" && d.approved_by) {
      const a = (
        await pool.query(
          "SELECT * FROM membership WHERE business_id=$1 AND user_id=$2 AND revoked_at IS NULL",
          [d.business_id, d.approved_by],
        )
      ).rows[0];
      if (
        !a ||
        !can(
          a.role,
          a.channel_scope,
          "approvals.write",
          d.platform,
          a.denied_permissions,
        )
      ) {
        await block("APPROVER_REVOKED");
        return;
      }
    }
    if (
      kind === "reply" &&
      ((!d.approved_by && !d.checks.passed) ||
        (d.checks.passed && !d.checks.humanEdited && !factsFresh(d.facts, now)))
    ) {
      await block("FACTS_STALE_AT_SEND");
      return;
    }
    if (!messageWindowOpen(d.conversation_kind, d.last_customer_at, now)) {
      await block("MESSENGER_WINDOW_CLOSED");
      return;
    }
    const { rules, version } = await loadRules(pool, d.business_id);
    if (kind === "holding" && !rules.holding_reply) return;
    if (kind === "reply" && !d.approved_by && version !== d.rule_version) {
      await block("RULES_CHANGED_REVIEW_REQUIRED");
      return;
    }
    if (
      kind === "reply" &&
      d.checks.passed &&
      !d.checks.humanEdited &&
      d.facts.length
    ) {
      const ids = [...new Set(d.facts.map((f: any) => f.versionId))];
      const current = await pool.query(
        "SELECT version_id FROM knowledge_current WHERE business_id=$1 AND version_id=ANY($2::uuid[])",
        [d.business_id, ids],
      );
      if (current.rowCount !== ids.length) {
        await block("KNOWLEDGE_CHANGED_REVIEW_REQUIRED");
        return;
      }
    }
    const currentVoice =
      (
        await pool.query(
          "SELECT version FROM voice_profile WHERE business_id=$1",
          [d.business_id],
        )
      ).rows[0]?.version ?? 0;
    if (!d.approved_by && currentVoice !== d.voice_version) {
      await block("VOICE_CHANGED_REVIEW_REQUIRED");
      return;
    }
    const text = kind === "holding" ? d.holding_text : d.text;
    if (!text) return;
    const recent = await pool.query(
      "SELECT 1 FROM reply_delivery x JOIN reply_draft r ON r.id=x.draft_id WHERE r.conversation_id=$1 AND x.payload->>'text'=$2 AND x.created_at>$3 AND x.status IN ('started','sent','would_have_sent','uncertain') LIMIT 1",
      [
        d.conversation_id,
        text,
        new Date(+now - rules.duplicate_minutes * 60000),
      ],
    );
    if (recent.rowCount) return;
    const mode = effectiveMode(c.HELPA_MODE, d.mode);
    const manual =
      d.conversation_kind === "manual" ||
      d.platform === "tiktok" ||
      mode === "manual";
    const semantic = {
      text,
      kind,
      conversationId: d.conversation_id,
      messageId: d.message_id,
      draftRevision: d.revision,
      facts:
        kind === "reply" && d.checks.passed && !d.checks.humanEdited
          ? d.facts
          : [],
      humanReviewed: !!d.approved_by,
      ruleVersion: d.rule_version,
    };
    if (
      mode === "live" &&
      !manual &&
      (d.channel_status !== "connected" ||
        !d.credentials_encrypted ||
        !d.granted_scopes.includes(
          d.conversation_kind === "messenger"
            ? "pages_messaging"
            : "pages_manage_engagement",
        ) ||
        (d.token_expires_at && Date.parse(d.token_expires_at) <= +now))
    ) {
      await block("CHANNEL_RECONNECT_REQUIRED");
      return;
    }
    const id = randomUUID();
    const start = await transaction(pool, async (db) => {
      if (kind === "reply") {
        const claim = await db.query(
          "UPDATE reply_draft SET status='sending' WHERE id=$1 AND revision=$2 AND status IN ('queued','approved') RETURNING id",
          [draftId, d.revision],
        );
        if (!claim.rowCount) return false;
      }
      const r = await db.query(
        "INSERT INTO reply_delivery(id,business_id,draft_id,kind,payload,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(draft_id,kind) DO NOTHING RETURNING id",
        [
          id,
          d.business_id,
          draftId,
          kind,
          semantic,
          mode === "dry_run"
            ? "would_have_sent"
            : manual
              ? "manual_ready"
              : "started",
        ],
      );
      if (!r.rowCount) {
        if (kind === "reply")
          await db.query(
            "UPDATE reply_draft SET status='needs_approval' WHERE id=$1",
            [draftId],
          );
        return false;
      }
      await audit(db, {
        businessId: d.business_id,
        actorId: d.approved_by ?? undefined,
        actorType: d.approved_by ? "user" : "worker",
        channelId: d.channel_id,
        action:
          mode === "dry_run"
            ? "reply.would_have_sent"
            : manual
              ? "reply.manual_ready"
              : "reply.attempt_started",
        payload: { deliveryId: id, exactPayload: semantic },
      });
      if (mode === "dry_run")
        await db.query(
          "INSERT INTO outbound_operation(id,business_id,channel_id,operation_key,payload,mode,outcome) VALUES($1,$2,$3,$4,$5,'dry_run','would_have_sent')",
          [
            randomUUID(),
            d.business_id,
            d.channel_id,
            `reply:${draftId}:${kind}`,
            semantic,
          ],
        );
      if (kind === "reply" && (mode === "dry_run" || manual))
        await db.query(
          "UPDATE reply_draft SET status=$2,updated_at=now() WHERE id=$1",
          [draftId, mode === "dry_run" ? "would_have_sent" : "manual_ready"],
        );
      return true;
    });
    if (!start || mode === "dry_run" || manual) return;
    try {
      const token: any = decrypt(
        d.credentials_encrypted,
        `${d.business_id}:channel:${d.channel_id}`,
        c,
      );
      const adapter = channelAdapter(d.platform, {
        config: c,
        credentials: token,
      });
      const payload = adapter.prepareReply({
        kind: d.conversation_kind,
        pageId: d.page_id,
        customerId: d.customer_id,
        threadId: d.thread_external_id,
        text,
      });
      const r = sender
        ? await sender(c, token.accessToken, payload)
        : await adapter.sendReply(payload);
      if (!r.id) throw new AppError(409, "MANUAL_REPLY_REQUIRED");
      const externalId = r.id;
      await transaction(pool, async (db) => {
        await db.query(
          "UPDATE reply_delivery SET status='sent',platform_id=$2,completed_at=now() WHERE id=$1",
          [id, r.id],
        );
        if (kind === "reply")
          await db.query(
            "UPDATE reply_draft SET status='sent',updated_at=now() WHERE id=$1",
            [draftId],
          );
        await ingestMessage(db, {
          businessId: d.business_id,
          channelId: d.channel_id,
          threadId: d.thread_external_id,
          customerId: d.customer_id,
          externalId,
          kind: d.conversation_kind,
          text,
          sentAt: now.toISOString(),
          fromBusiness: true,
        });
        await audit(db, {
          businessId: d.business_id,
          actorId: d.approved_by ?? undefined,
          actorType: d.approved_by ? "user" : "worker",
          channelId: d.channel_id,
          action: "reply.sent",
          payload: { deliveryId: id, platformId: r.id, exactPayload: semantic },
        });
      });
    } catch (e) {
      await pool.query(
        "UPDATE reply_delivery SET status='uncertain',error=$2 WHERE id=$1",
        [id, e instanceof AppError ? e.code : "EXTERNAL_OUTCOME_UNKNOWN"],
      );
      await block("EXTERNAL_OUTCOME_UNKNOWN");
    }
    async function block(reason: string) {
      await transaction(pool, async (db) => {
        if (kind === "holding")
          await db.query(
            "INSERT INTO reply_delivery(id,business_id,draft_id,kind,payload,status,error) VALUES($1,$2,$3,'holding','{}','blocked',$4) ON CONFLICT(draft_id,kind) DO NOTHING",
            [randomUUID(), d.business_id, draftId, reason],
          );
        const changed = await db.query(
          "UPDATE reply_draft SET status='needs_approval',checks=jsonb_set(checks,'{reasons}',coalesce(checks->'reasons','[]')||to_jsonb($2::text)),updated_at=now() WHERE id=$1 AND NOT(coalesce(checks->'reasons','[]') ? $2) RETURNING id",
          [draftId, reason],
        );
        if (changed.rowCount)
          await audit(db, {
            businessId: d.business_id,
            channelId: d.channel_id,
            actorType: "worker",
            action: "reply.blocked",
            payload: { draftId, kind, reason },
          });
      });
    }
  } finally {
    if (locked)
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        `reply:${(await pool.query("SELECT conversation_id FROM reply_draft WHERE id=$1", [draftId])).rows[0].conversation_id}`,
      ]);
    lock.release();
  }
}
