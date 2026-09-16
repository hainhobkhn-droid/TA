import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { transaction, type PgPool } from "../db/index.js";
import { actorFor, type Auth } from "../auth/index.js";
import { AppError } from "../errors.js";
import { audit } from "../audit/index.js";
import { datasetNames, mapRows } from "./schema.js";
import { syncRows, currentKnowledge } from "./service.js";
import { parseUpload } from "./import.js";
import { fetchSource } from "./google.js";
import type { Config } from "../config.js";
import {
  loadRules,
  rulesSchema,
  defaultVoice,
  voiceSchema,
} from "../rules/service.js";
import { fallbackAnalysis, runEngine } from "../inbox/engine.js";
export async function knowledgeRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
  c: Config,
) {
  const manage = async (req: any) => {
    const a = await actorFor(auth, pool, req);
    if (
      !["owner", "manager"].includes(a.role) ||
      (a.role === "manager" && !a.channelScope.includes("*"))
    )
      throw new AppError(403, "FORBIDDEN");
    return a;
  };
  app.get("/api/knowledge", async (req) => {
    const a = await manage(req);
    return {
      sources: (
        await pool.query(
          "SELECT * FROM knowledge_source WHERE business_id=$1 ORDER BY created_at",
          [a.businessId],
        )
      ).rows,
      records: await currentKnowledge(pool, a.businessId),
      syncs: (
        await pool.query(
          "SELECT * FROM knowledge_sync WHERE business_id=$1 ORDER BY created_at DESC LIMIT 30",
          [a.businessId],
        )
      ).rows,
    };
  });
  app.post("/api/knowledge/sources", async (req) => {
    const a = await manage(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        dataset: z.enum(datasetNames),
        kind: z.enum(["builtin", "csv", "xlsx", "google_csv", "google_api"]),
        maxAgeHours: z.number().positive().max(8760),
        url: z.string().url().optional(),
        spreadsheetId: z
          .string()
          .regex(/^[\w-]+$/)
          .optional(),
        range: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO knowledge_source(id,business_id,name,kind,dataset,max_age_hours,config) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          a.businessId,
          b.name,
          b.kind,
          b.dataset,
          b.maxAgeHours,
          { url: b.url, spreadsheetId: b.spreadsheetId, range: b.range },
        ],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "knowledge.source_created",
        payload: { id, ...b },
      });
    });
    return { id };
  });
  app.post("/api/knowledge/preview", { bodyLimit: 8000000 }, async (req) => {
    await manage(req);
    const b = z
      .object({
        dataset: z.enum(datasetNames),
        format: z.enum(["csv", "xlsx"]),
        content: z.string(),
        mapping: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .parse(req.body);
    const raw = await parseUpload(b.content, b.format);
    const mapped = mapRows(b.dataset, raw, b.mapping);
    return {
      columns: Object.keys(raw[0] ?? {}),
      rows: raw.slice(0, 10),
      rowCount: raw.length,
      errors: mapped.errors.slice(0, 20),
      preview: mapped.rows.slice(0, 10),
    };
  });
  app.post("/api/knowledge/:id/sync", { bodyLimit: 8000000 }, async (req) => {
    const a = await manage(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        rows: z.array(z.record(z.string(), z.unknown())).max(10000).optional(),
        format: z.enum(["csv", "xlsx"]).optional(),
        content: z.string().optional(),
        mapping: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const s = (
      await pool.query(
        "SELECT * FROM knowledge_source WHERE business_id=$1 AND id=$2",
        [a.businessId, id],
      )
    ).rows[0];
    if (!s) throw new AppError(404, "NOT_FOUND");
    const raw =
      b.rows ??
      (b.content && b.format
        ? await parseUpload(b.content, b.format)
        : ["google_csv", "google_api"].includes(s.kind)
          ? await fetchSource(c, s)
          : null);
    if (!raw) throw new AppError(400, "SOURCE_INPUT_REQUIRED");
    return syncRows(pool, a, id, raw, b.mapping);
  });
  app.get("/api/rules", async (req) => {
    const a = await manage(req);
    return {
      ...(await loadRules(pool, a.businessId)),
      history: (
        await pool.query(
          "SELECT version,created_by,created_at FROM rule_revision WHERE business_id=$1 ORDER BY version DESC",
          [a.businessId],
        )
      ).rows,
    };
  });
  app.post("/api/rules", async (req) => {
    const a = await manage(req);
    const b = z
      .object({
        yaml: z.string().max(20000),
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(req.body);
    const rules = rulesSchema.parse(parse(b.yaml, { maxAliasCount: 20 }));
    return transaction(pool, async (db) => {
      await db.query("SELECT id FROM business WHERE id=$1 FOR UPDATE", [
        a.businessId,
      ]);
      const version = Number(
        (
          await db.query(
            "SELECT coalesce(max(version),0) AS v FROM rule_revision WHERE business_id=$1",
            [a.businessId],
          )
        ).rows[0].v,
      );
      if (version !== b.expectedVersion)
        throw new AppError(409, "REVISION_CONFLICT");
      await db.query(
        "INSERT INTO rule_revision(id,business_id,version,yaml,config,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), a.businessId, version + 1, b.yaml, rules, a.userId],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "rules.updated",
        payload: { version: version + 1, rules },
      });
      return { version: version + 1 };
    });
  });
  app.post("/api/rules/test", async (req) => {
    const a = await manage(req);
    const b = z
      .object({ text: z.string().min(1).max(4000) })
      .strict()
      .parse(req.body);
    const { rules } = await loadRules(pool, a.businessId);
    return {
      ...runEngine(
        b.text,
        fallbackAnalysis(b.text),
        await currentKnowledge(pool, a.businessId),
        rules,
      ),
      engine: "offline_conservative_preview",
    };
  });
  app.get("/api/voice", async (req) => {
    const a = await manage(req);
    const v = (
      await pool.query("SELECT * FROM voice_profile WHERE business_id=$1", [
        a.businessId,
      ])
    ).rows[0];
    return v ?? { version: 0, config: defaultVoice };
  });
  app.post("/api/voice", async (req) => {
    const a = await manage(req);
    const b = z
      .object({
        config: voiceSchema,
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .parse(req.body);
    return transaction(pool, async (db) => {
      await db.query("SELECT id FROM business WHERE id=$1 FOR UPDATE", [
        a.businessId,
      ]);
      const old =
        (
          await db.query(
            "SELECT version FROM voice_profile WHERE business_id=$1",
            [a.businessId],
          )
        ).rows[0]?.version ?? 0;
      if (old !== b.expectedVersion)
        throw new AppError(409, "REVISION_CONFLICT");
      await db.query(
        "INSERT INTO voice_profile(business_id,config,approved_by,version) VALUES($1,$2,$3,1) ON CONFLICT(business_id) DO UPDATE SET config=excluded.config,approved_by=excluded.approved_by,version=voice_profile.version+1,updated_at=now()",
        [a.businessId, b.config, a.userId],
      );
      await audit(db, {
        businessId: a.businessId,
        actorId: a.userId,
        action: "voice.approved",
        payload: { version: old + 1, config: b.config },
      });
      return { ok: true };
    });
  });
}
