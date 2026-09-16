import { type Analysis } from "../llm/gateway.js";
import { type Rules, defaultVoice, intents } from "../rules/service.js";
export function normalize(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const keywords: Record<string, RegExp> = {
  inventory: /\b(con|het|san|stock|available|availability)\b/,
  pricing: /\b(gia|bao nhieu|bn|price|cost|how much)\b/,
  shipping: /\b(ship|giao|van chuyen|phi vc|delivery|deliver|shipping)\b/,
  order_status:
    /\b(don hang|ma don|order status|where is my order|tracking|track my)\b/,
  how_to_order:
    /\b(dat hang|mua sao|mua the nao|dat sao|cach mua|how to order|how do i order|payment|thanh toan)\b/,
  complaint:
    /\b(khieu nai|hong|thoi|lua dao|hoan tien|te|complaint|rotten|refund|damaged|bad service)\b/,
  compliment: /\b(cam on|ngon|tuyet|thanks|thank you|delicious|great)\b/,
  spam: /\b(casino|vay tien|co bac|win money|gambling)\b/,
};
export function fallbackAnalysis(text: string): Analysis {
  const n = normalize(text);
  const found = intents.filter((i) => keywords[i]?.test(n));
  return {
    language:
      /\b(price|how|shipping|delivery|stock|hello|thanks|order|available|refund|rotten)\b/.test(
        n,
      )
        ? "en"
        : "vi",
    intents: found.length ? found : ["other"],
    confidence: 0.5,
    entities: {
      products: [],
      size: n.match(/\bsize\s*(\d+)/)?.[1] ?? null,
      quantity: null,
      location: null,
      orderId:
        text.match(
          /(?:#|mã đơn\s*|ma don\s*|order\s*#?)([A-Za-z0-9-]{3,})/i,
        )?.[1] ?? null,
      phone: null,
    },
  };
}
export type Knowledge = {
  id: string;
  source_id: string;
  record_key: string;
  version: number;
  source_row: number;
  dataset: string;
  data: any;
  field_timestamps: Record<string, string>;
  max_age_hours: number;
  source_name?: string;
  approved_by?: string;
};
export type Fact = {
  versionId: string;
  sourceId: string;
  recordKey: string;
  recordVersion: number;
  sourceRow: number;
  dataset: string;
  field: string;
  value: any;
  asOf: string;
  maxAgeHours: number;
};
export type EngineResult = {
  text: string;
  holdingText: string;
  analysis: Analysis;
  facts: Fact[];
  checks: { passed: boolean; reasons: string[]; expectedText: string };
  autonomy: string;
};
function distance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length];
}
export function matchProducts(
  text: string,
  analysis: Analysis,
  records: Knowledge[],
) {
  const n = normalize(text);
  const products = records.filter((r) => r.dataset === "products");
  const mentions = analysis.entities.products.filter((p) =>
    n.includes(normalize(p)),
  );
  const queries = mentions.length ? mentions : [text];
  const result: Knowledge[] = [];
  let ambiguous = false;
  for (const q of queries) {
    const query = normalize(q);
    const candidates = products
      .map((r) => {
        const aliases = [
          r.data.name_vi,
          r.data.name_en,
          r.data.sku,
          ...(r.data.aliases ?? []),
        ]
          .filter(Boolean)
          .map(normalize);
        const size = analysis.entities.size
          ? normalize(analysis.entities.size)
          : null;
        const scores = aliases.map((alias) => {
          if (size && !alias.split(" ").includes(size)) return 0;
          if (
            n.includes(alias) &&
            (!mentions.length || alias.includes(query) || query.includes(alias))
          )
            return 1 + alias.length / 1000;
          if (mentions.length && Math.max(alias.length, query.length) > 4) {
            const sim =
              1 - distance(alias, query) / Math.max(alias.length, query.length);
            return sim > 0.8 ? sim : 0;
          }
          return 0;
        });
        return { r, score: Math.max(0, ...scores) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) continue;
    const best = candidates[0].score;
    const matches = candidates.filter((x) => Math.abs(x.score - best) < 0.04);
    if (matches.length !== 1) {
      ambiguous = true;
      continue;
    }
    if (!result.some((r) => r.id === matches[0].r.id))
      result.push(matches[0].r);
  }
  return { records: result, ambiguous };
}
export function factsFresh(facts: Fact[], now = new Date()) {
  return facts.every(
    (f) =>
      Number.isFinite(Date.parse(f.asOf)) &&
      Date.parse(f.asOf) <= +now &&
      +now - Date.parse(f.asOf) <= f.maxAgeHours * 3600000,
  );
}
export function factGate(
  candidate: string,
  expected: string,
  facts: Fact[],
  rules: Rules,
  now = new Date(),
) {
  const reasons: string[] = [];
  if (candidate !== expected) reasons.push("FACT_TEXT_CHANGED");
  if (!factsFresh(facts, now)) reasons.push("STALE_FACT");
  for (const phrase of [
    ...rules.forbidden_claims,
    "chữa bệnh",
    "trị bệnh",
    "phòng bệnh",
    "tươi nhất",
    "sạch 100%",
    "cure disease",
    "nhập khẩu",
    "xuất xứ",
  ])
    if (
      normalize(candidate).includes(normalize(phrase)) &&
      !facts.some(
        (f) =>
          ["answer_vi", "answer_en", "notes_public"].includes(f.field) &&
          String(f.value).includes(phrase),
      )
    )
      reasons.push("FORBIDDEN_CLAIM");
  return { passed: !reasons.length, reasons, expectedText: expected };
}
export function runEngine(
  text: string,
  analysis: Analysis,
  records: Knowledge[],
  rules: Rules,
  voice = defaultVoice,
  now = new Date(),
): EngineResult {
  const a = structuredClone(analysis);
  const fallback = fallbackAnalysis(text);
  if (
    fallback.intents.includes("complaint") &&
    !a.intents.includes("complaint")
  )
    a.intents.push("complaint");
  a.intents = [...new Set(a.intents)];
  const n = normalize(text);
  const reasons: string[] = [];
  const facts: Fact[] = [];
  const sentences: string[] = [];
  const en = a.language === "en";
  // Voice formatting applies only to style text, never to immutable source fields.
  const style = (value: string) => {
    const addressed = value.replace(
      /\{addressing\}|anh\/chị/gi,
      () => voice.addressing,
    );
    return voice.emoji
      ? addressed
      : addressed
          .replace(
            /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu,
            "",
          )
          .trim();
  };
  const disclosure = en
    ? defaultVoice.disclosure_en
    : defaultVoice.disclosure_vi;
  const holdingText = [
    style(en ? voice.holding_en : voice.holding_vi),
    disclosure,
  ].join("\n");
  const get = (r: Knowledge, field: string, maxHours: number) => {
    const value = r.data[field];
    const asOf = r.field_timestamps[field];
    if (value === undefined || value === null || value === "") {
      reasons.push("MISSING_FACT:" + r.dataset + "." + field);
      return undefined;
    }
    const f = {
      versionId: r.id,
      sourceId: r.source_id,
      recordKey: r.record_key,
      recordVersion: r.version,
      sourceRow: r.source_row,
      dataset: r.dataset,
      field,
      value,
      asOf,
      maxAgeHours: Math.min(maxHours, Number(r.max_age_hours)),
    };
    facts.push(f);
    if (!factsFresh([f], now))
      reasons.push("STALE_FACT:" + r.dataset + "." + field);
    return value;
  };
  if (a.confidence < rules.confidence) reasons.push("LOW_CONFIDENCE");
  if (/\b(nhan vien|nguoi that|human|person|agent)\b/.test(n))
    reasons.push("HUMAN_REQUESTED");
  const matches = matchProducts(text, a, records);
  if (matches.ambiguous) reasons.push("AMBIGUOUS_PRODUCT");
  if (a.intents.some((i) => i === "pricing" || i === "inventory")) {
    if (!matches.records.length) reasons.push("MISSING_PRODUCT");
    if (a.entities.products.length > matches.records.length)
      reasons.push("MISSING_PRODUCT");
    for (const r of matches.records) {
      const product = get(
        r,
        en && r.data.name_en ? "name_en" : "name_vi",
        rules.freshness.faq,
      );
      const unit = get(r, "unit", rules.freshness.price);
      if (a.intents.includes("pricing")) {
        const price = get(r, "price", rules.freshness.price);
        const currency = get(r, "currency", rules.freshness.price);
        if (price !== undefined && currency && product && unit)
          sentences.push(
            en
              ? `${product}: ${price} ${currency}/${unit}.`
              : `${product}: ${price} ${currency}/${unit}.`,
          );
      }
      if (a.intents.includes("inventory")) {
        const stock = get(r, "stock_status", rules.freshness.stock);
        const labels: Record<string, string> = en
          ? {
              in_stock: "in stock",
              low: "low stock",
              out: "out of stock",
              preorder: "preorder only",
            }
          : {
              in_stock: "còn hàng",
              low: "sắp hết hàng",
              out: "hết hàng",
              preorder: "chỉ nhận đặt trước",
            };
        if (stock && product) sentences.push(`${product}: ${labels[stock]}.`);
        if (r.data.stock_qty !== undefined) {
          const qty = get(r, "stock_qty", rules.freshness.stock);
          if (qty !== undefined && unit)
            sentences.push(
              en
                ? `Available quantity: ${qty} ${unit}.`
                : `Số lượng hiện có: ${qty} ${unit}.`,
            );
        }
      }
    }
  }
  if (a.intents.includes("shipping")) {
    const zones = records.filter(
      (r) =>
        r.dataset === "shipping_zones" &&
        [r.data.zone_name, ...r.data.provinces].some((v: string) =>
          n.includes(normalize(v)),
        ),
    );
    if (zones.length !== 1)
      reasons.push(
        zones.length ? "AMBIGUOUS_SHIPPING_ZONE" : "MISSING_SHIPPING_ZONE",
      );
    else {
      const r = zones[0];
      const zone = get(r, "zone_name", rules.freshness.shipping_zones);
      const fee = get(r, "fee", rules.freshness.shipping_zones);
      const currency = get(r, "currency", rules.freshness.shipping_zones);
      const min = get(r, "lead_time_hours_min", rules.freshness.shipping_zones);
      const max = get(r, "lead_time_hours_max", rules.freshness.shipping_zones);
      let shipping = en
        ? `Delivery to ${zone}: ${fee} ${currency}; estimated ${min}–${max} hours.`
        : `Giao ${zone}: ${fee} ${currency}; dự kiến ${min}–${max} giờ.`;
      if (r.data.free_over !== undefined) {
        const over = get(r, "free_over", rules.freshness.shipping_zones);
        shipping += en
          ? ` Free delivery for orders from ${over} ${currency}.`
          : ` Miễn phí giao hàng cho đơn từ ${over} ${currency}.`;
      }
      sentences.push(shipping);
    }
  }
  if (a.intents.includes("how_to_order")) {
    const list = records.filter(
      (r) => r.dataset === "faq" && r.data.intent === "how_to_order",
    );
    const matched = list.filter((r) =>
      r.data.question_patterns.some((p: string) => n.includes(normalize(p))),
    );
    const matches = matched.length ? matched : list;
    if (matches.length !== 1) reasons.push("MISSING_OR_AMBIGUOUS_FAQ");
    else {
      const copy = get(
        matches[0],
        en ? "answer_en" : "answer_vi",
        rules.freshness.faq,
      );
      if (copy) sentences.push(copy);
    }
  }
  if (a.intents.includes("order_status")) {
    const key = a.entities.orderId;
    const match =
      key && text.includes(key)
        ? records.filter(
            (r) => r.dataset === "orders" && r.data.order_id === key,
          )
        : [];
    if (match.length !== 1) reasons.push("MISSING_OR_AMBIGUOUS_ORDER");
    else {
      const order = get(match[0], "order_id", rules.freshness.orders);
      const status = get(match[0], "status", rules.freshness.orders);
      if (order && status)
        sentences.push(
          en ? `Order ${order}: ${status}.` : `Đơn ${order}: ${status}.`,
        );
    }
  }
  if (a.intents.includes("other")) reasons.push("HUMAN_REVIEW_REQUIRED");
  if (a.intents.includes("complaint")) reasons.push("COMPLAINT_EMAIL_ONLY");
  if (a.intents.includes("compliment"))
    sentences.push(style(en ? voice.thanks_en : voice.thanks_vi));
  let autonomy = "auto_send";
  const levels = {
    auto_send: 0,
    draft_for_approval: 1,
    human_only: 2,
    none: 3,
  };
  for (const i of a.intents)
    if (levels[rules.intents[i]] > levels[autonomy as keyof typeof levels])
      autonomy = rules.intents[i];
  if (a.intents.includes("complaint")) autonomy = "human_only";
  else if (a.intents.includes("spam")) autonomy = "none";
  else if (reasons.length)
    autonomy = autonomy === "human_only" ? "human_only" : "draft_for_approval";
  const expected = [
    style(en ? voice.greeting_en : voice.greeting_vi),
    ...sentences,
    style(en ? voice.signoff_en : voice.signoff_vi),
    style(en ? voice.disclosure_en : voice.disclosure_vi),
    disclosure,
  ]
    .filter((v, i, all) => !!v && all.indexOf(v) === i)
    .join("\n");
  const gate = factGate(
    expected,
    expected,
    facts,
    {
      ...rules,
      forbidden_claims: [...rules.forbidden_claims, ...voice.forbidden_phrases],
    },
    now,
  );
  reasons.push(...gate.reasons);
  if (!gate.passed && autonomy === "auto_send") autonomy = "draft_for_approval";
  // All-or-nothing multi-intent: missing, stale, ambiguous and unsafe facts remain only in the operator panel.
  const safe = autonomy === "auto_send" && !reasons.length;
  return {
    text: autonomy === "none" ? "" : safe ? expected : holdingText,
    holdingText,
    analysis: a,
    facts,
    checks: {
      passed: safe,
      reasons: [...new Set(reasons)],
      expectedText: safe ? expected : holdingText,
    },
    autonomy,
  };
}
