import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { rulesSchema, defaultVoice } from "../src/server/rules/service.js";
import {
  runEngine,
  matchProducts,
  factGate,
  fallbackAnalysis,
  type Knowledge,
} from "../src/server/inbox/engine.js";
import {
  analysisSchema,
  type Analysis,
  budgetMonth,
} from "../src/server/llm/gateway.js";
import { messageWindowOpen } from "../src/server/inbox/service.js";
import golden from "./fixtures/inquiries.vi.json" with { type: "json" };
import multilingual from "./fixtures/inquiries.multilingual.json" with { type: "json" };
const rules = rulesSchema.parse(
  parse(readFileSync("config/rules.example.yaml", "utf8")),
);
const now = new Date("2026-09-08T12:00:00Z");
function record(dataset: string, data: any): Knowledge {
  return {
    id: dataset,
    source_id: "source",
    record_key: data.sku ?? data.zone_name ?? data.id,
    version: 1,
    source_row: 2,
    dataset,
    data,
    field_timestamps: Object.fromEntries(
      Object.keys(data).map((k) => [k, now.toISOString()]),
    ),
    max_age_hours: 720,
  };
}
export const records = [
  record("products", {
    sku: "T20",
    name_vi: "Tôm sú size 20",
    name_en: "Tiger prawns size 20",
    aliases: ["tôm sú size 20"],
    unit: "kg",
    price: 320000,
    currency: "VND",
    stock_status: "in_stock",
    stock_qty: 8,
  }),
  record("shipping_zones", {
    zone_name: "Bình Thạnh",
    provinces: ["Bình Thạnh"],
    fee: 30000,
    currency: "VND",
    lead_time_hours_min: 2,
    lead_time_hours_max: 4,
  }),
  record("faq", {
    id: "order",
    intent: "how_to_order",
    question_patterns: ["đặt hàng"],
    answer_vi: "Anh/chị gửi mã sản phẩm và số lượng cho nhân viên.",
    answer_en: "Send the product code and quantity to our staff.",
  }),
  record("orders", { order_id: "DH123", status: "đang giao" }),
];
function analysis(
  intents: Analysis["intents"],
  extra: Partial<Analysis["entities"]> = {},
): Analysis {
  return {
    language: "vi",
    intents,
    confidence: 0.99,
    entities: {
      products: [],
      size: null,
      quantity: null,
      location: null,
      orderId: null,
      phone: null,
      ...extra,
    },
  };
}
it.each([...golden, ...multilingual])(
  "golden policy fixture $id: $text",
  (g) => {
    const a = analysisSchema.parse(g.analysis);
    const r = runEngine(g.text, a, records, rules, defaultVoice, now);
    expect(r.autonomy).toBe(g.outcome);
    expect(r.analysis.intents).toEqual(expect.arrayContaining(g.intents));
    if (r.autonomy === "auto_send") {
      expect(r.checks.passed).toBe(true);
      expect(r.text).not.toMatch(/undefined|NaN/);
    } else if (r.autonomy !== "none") expect(r.text).toBe(r.holdingText);
  },
);
it("uses exact source versions and rejects even a one-digit price mutation", () => {
  const r = runEngine(
    "Giá tôm sú size 20?",
    analysis(["pricing"], { products: ["tôm sú size 20"], size: "20" }),
    records,
    rules,
    defaultVoice,
    now,
  );
  expect(r.text).toContain("320000 VND/kg");
  expect(r.facts.find((f) => f.field === "price")).toMatchObject({
    versionId: "products",
    recordVersion: 1,
    sourceRow: 2,
    value: 320000,
  });
  expect(
    factGate(r.text.replace("320000", "320001"), r.text, r.facts, rules, now)
      .passed,
  ).toBe(false);
});
it("keeps all stale multi-intent facts out of customer text", () => {
  const old = structuredClone(records);
  old[0].field_timestamps.stock_qty = "2026-09-07T00:00:00Z";
  const r = runEngine(
    "Tôm sú size 20 còn không, giá bao nhiêu, ship Bình Thạnh?",
    analysis(["inventory", "pricing", "shipping"]),
    old,
    rules,
    defaultVoice,
    now,
  );
  expect(r.facts.length).toBeGreaterThan(8);
  expect(r.text).not.toMatch(/320000|30000|8 kg/);
  expect(r.checks.reasons).toContain("STALE_FACT:products.stock_qty");
});
it("rejects ambiguous and non-verbatim invented entities", () => {
  const duplicate = {
    ...records[0],
    id: "other",
    data: { ...records[0].data, sku: "T20B" },
  };
  expect(
    matchProducts("tôm sú size 20", analysis(["pricing"]), [
      ...records,
      duplicate,
    ]).ambiguous,
  ).toBe(true);
  expect(
    runEngine(
      "bao nhiêu?",
      analysis(["pricing"], { products: ["tôm sú size 20"] }),
      records,
      rules,
      defaultVoice,
      now,
    ).autonomy,
  ).toBe("draft_for_approval");
});
it("does not expose other customer data for a matched order", () => {
  const r = runEngine(
    "Mã đơn DH123 đang ở đâu?",
    analysis(["order_status"], { orderId: "DH123" }),
    records,
    rules,
    defaultVoice,
    now,
  );
  expect(r.facts.map((f) => f.field)).toEqual(["order_id", "status"]);
});
it("hard overrides complaint misclassification and cannot disable disclosure", () => {
  const r = runEngine(
    "Tôm bị hỏng, hoàn tiền",
    analysis(["compliment"]),
    records,
    rules,
    { ...defaultVoice, disclosure_vi: "", holding_vi: "Đã nhận" },
    now,
  );
  expect(r.autonomy).toBe("human_only");
  expect(r.analysis.intents).toContain("complaint");
  expect(r.text).toContain("Trợ lý tự động");
});
it("respects brand forbidden phrases and rejects unverifiable origin", () => {
  const r = runEngine(
    "Cảm ơn",
    analysis(["compliment"]),
    records,
    rules,
    { ...defaultVoice, thanks_vi: "Hàng nhập khẩu tốt nhất" },
    now,
  );
  expect(r.autonomy).toBe("draft_for_approval");
  expect(r.text).not.toContain("nhập khẩu");
});
it("offline fallback never authorizes an automatic response", () => {
  for (const g of golden) {
    const r = runEngine(
      g.text,
      fallbackAnalysis(g.text),
      records,
      rules,
      defaultVoice,
      now,
    );
    expect(r.autonomy).not.toBe("auto_send");
  }
});
it("uses the customer timestamp and a strict 24-hour boundary", () => {
  expect(messageWindowOpen("messenger", "2026-09-07T12:00:00Z", now)).toBe(
    false,
  );
  expect(messageWindowOpen("messenger", "2026-09-07T12:00:01Z", now)).toBe(
    true,
  );
  expect(messageWindowOpen("messenger", "2026-09-09T12:00:00Z", now)).toBe(
    false,
  );
  expect(budgetMonth(new Date("2026-08-31T17:00:00Z"))).toBe("2026-09");
});

import { providerSchema } from "../src/server/llm/gateway.js";
import { z } from "zod";
it("simplifies unsupported provider schema constraints while retaining local validation", () => {
  const wire = providerSchema(z.toJSONSchema(analysisSchema));
  expect(wire.properties.confidence.maximum).toBeUndefined();
  expect(wire.properties.confidence.description).toContain("maximum=1");
  expect(wire.properties.entities.properties.products.maxItems).toBeUndefined();
  expect(wire.properties.entities.additionalProperties).toBe(false);
  expect(
    analysisSchema.safeParse({ ...analysis(["pricing"]), confidence: 1.2 })
      .success,
  ).toBe(false);
});

import { mapRows } from "../src/server/knowledge/schema.js";
it("rejects blank or contradictory facts and derives stock only from explicit quantity", () => {
  const product = { ...records[0].data, updated_at: now.toISOString() };
  expect(mapRows("products", [{ ...product, price: " " }]).errors).toHaveLength(
    1,
  );
  expect(
    mapRows("products", [{ ...product, price: false }]).errors,
  ).toHaveLength(1);
  expect(
    mapRows("products", [{ ...product, stock_qty: 0 }]).errors,
  ).toHaveLength(1);
  const { stock_status, ...quantityOnly } = product;
  expect(mapRows("products", [quantityOnly]).rows[0].stock_status).toBe(
    "in_stock",
  );
  expect(
    mapRows("products", [{ ...quantityOnly, stock_qty: 0 }]).rows[0]
      .stock_status,
  ).toBe("out");
});

it("applies addressing and emoji preferences only to voice text", () => {
  const voice = {
    ...defaultVoice,
    addressing: "bạn",
    thanks_vi: "Cảm ơn anh/chị 🙂",
    emoji: false,
  };
  const r = runEngine(
    "Cảm ơn shop",
    analysis(["compliment"]),
    records,
    rules,
    voice,
    now,
  );
  expect(r.text).toContain("Cảm ơn bạn");
  expect(r.text).not.toContain("🙂");
  const withEmoji = runEngine(
    "Cảm ơn shop",
    analysis(["compliment"]),
    records,
    rules,
    { ...voice, emoji: true },
    now,
  );
  expect(withEmoji.text).toContain("🙂");
});
