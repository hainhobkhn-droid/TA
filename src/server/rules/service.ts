import { z } from "zod";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";
import type { PgPool } from "../db/index.js";
export const intents = [
  "inventory",
  "pricing",
  "shipping",
  "order_status",
  "how_to_order",
  "complaint",
  "compliment",
  "spam",
  "other",
] as const;
export const autonomy = z.enum([
  "auto_send",
  "draft_for_approval",
  "human_only",
  "none",
]);
export const rulesSchema = z
  .object({
    version: z.number().int().positive(),
    confidence: z.number().min(0.5).max(1),
    holding_reply: z.boolean(),
    duplicate_minutes: z.number().int().min(1).max(1440),
    coverage: z.literal("24/7/365"),
    freshness: z
      .object({
        price: z.number().positive().max(720),
        stock: z.number().positive().max(168),
        shipping_zones: z.number().positive().max(2160),
        faq: z.number().positive().max(8760),
        orders: z.number().positive().max(168),
        policies: z.number().positive().max(8760),
      })
      .strict(),
    intents: z.record(z.enum(intents), autonomy),
    forbidden_claims: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict()
  .refine(
    (r) => r.intents.complaint === "human_only" && r.intents.spam === "none",
    { message: "Complaints must remain human_only; spam must remain none" },
  );
export type Rules = z.infer<typeof rulesSchema>;
export async function loadRules(
  pool: PgPool,
  businessId: string,
): Promise<{ rules: Rules; yaml: string; version: number }> {
  const r = (
    await pool.query(
      "SELECT * FROM rule_revision WHERE business_id=$1 ORDER BY version DESC LIMIT 1",
      [businessId],
    )
  ).rows[0];
  const yaml = r?.yaml ?? (await readFile("config/rules.example.yaml", "utf8"));
  return {
    rules: rulesSchema.parse(parse(yaml, { maxAliasCount: 20 })),
    yaml,
    version: r?.version ?? 0,
  };
}
export const defaultVoice = {
  addressing: "anh/chị",
  greeting_vi: "Dạ",
  greeting_en: "Hello",
  signoff_vi: "",
  signoff_en: "",
  emoji: false,
  holding_vi:
    "Em là trợ lý tự động. Em chuyển câu hỏi để anh/chị được nhân viên hỗ trợ nhé.",
  holding_en:
    "I’m the automated assistant. I’ll pass your question to a person who can help.",
  thanks_vi: "Cảm ơn anh/chị đã ủng hộ ạ!",
  thanks_en: "Thank you for your kind words!",
  disclosure_vi: "Trợ lý tự động · Nhắn “nhân viên” để gặp người hỗ trợ.",
  disclosure_en: "Automated assistant · Ask for a person at any time.",
  forbidden_phrases: [] as string[],
  samples_md: "",
};
export const voiceSchema = z
  .object(
    Object.fromEntries(
      Object.entries(defaultVoice).map(([k, v]) => [
        k,
        typeof v === "boolean"
          ? z.boolean()
          : Array.isArray(v)
            ? z.array(z.string().max(100)).max(100)
            : z.string().max(k === "samples_md" ? 10000 : 500),
      ]),
    ) as unknown as {
      [K in keyof typeof defaultVoice]: z.ZodType<(typeof defaultVoice)[K]>;
    },
  )
  .strict();
