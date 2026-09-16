import { z } from "zod";
const text = z.string().trim().max(4000);
const required = z.string().trim().min(1).max(300);
const money = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().finite().nonnegative(),
);
const timestamp = z.string().datetime({ offset: true });
const list = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v
          .split(/[;|]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : v,
  z.array(required).max(100),
);
const common = { updated_at: timestamp };
export const schemas = {
  products: z
    .object({
      ...common,
      sku: required,
      name_vi: required,
      name_en: text.default(""),
      aliases: list.default([]),
      unit: required,
      price: money,
      currency: z.enum(["VND", "USD"]),
      stock_status: z.enum(["in_stock", "low", "out", "preorder"]).optional(),
      stock_qty: money.optional(),
      min_order: money.optional(),
      notes_public: text.default(""),
      price_updated_at: timestamp.optional(),
      stock_updated_at: timestamp.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.stock_status === undefined && v.stock_qty === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["stock_status"],
          message: "Stock quantity or status is required",
        });
      if (
        v.stock_qty !== undefined &&
        ((v.stock_qty === 0 &&
          ["in_stock", "low"].includes(v.stock_status ?? "")) ||
          (v.stock_qty > 0 && v.stock_status === "out"))
      )
        ctx.addIssue({
          code: "custom",
          path: ["stock_qty"],
          message: "Stock quantity contradicts stock status",
        });
    })
    .transform((v) => ({
      ...v,
      stock_status: v.stock_status ?? (v.stock_qty === 0 ? "out" : "in_stock"),
    })),
  shipping_zones: z
    .object({
      ...common,
      zone_name: required,
      provinces: list,
      fee: money,
      free_over: money.optional(),
      currency: z.enum(["VND", "USD"]).default("VND"),
      lead_time_hours_min: money,
      lead_time_hours_max: money,
      carrier: text.default(""),
      cod_allowed: z
        .preprocess(
          (v) => (v === "true" ? true : v === "false" ? false : v),
          z.boolean(),
        )
        .default(false),
      notes_public: text.default(""),
    })
    .strict()
    .refine((v) => v.lead_time_hours_max >= v.lead_time_hours_min, {
      message: "Delivery maximum must be >= minimum",
    }),
  faq: z
    .object({
      ...common,
      id: required,
      question_patterns: list,
      answer_vi: required,
      answer_en: text.default(""),
      intent: z.enum(["how_to_order", "other", "shipping", "order_status"]),
    })
    .strict(),
  policies: z
    .object({
      ...common,
      id: required,
      topic: required,
      answer_vi: required,
      answer_en: text.default(""),
    })
    .strict(),
  orders: z
    .object({
      ...common,
      order_id: required,
      date: text.default(""),
      customer: text.default(""),
      phone: text.default(""),
      items: text.default(""),
      kg: money.optional(),
      total: money.optional(),
      currency: z.enum(["VND", "USD"]).default("VND"),
      lines: z
        .preprocess(
          (v) =>
            typeof v === "string"
              ? (() => {
                  try {
                    return JSON.parse(v);
                  } catch {
                    return v;
                  }
                })()
              : v,
          z
            .array(
              z
                .object({ sku: required, quantity: money, line_total: money })
                .strict(),
            )
            .max(100),
        )
        .default([]),
      status: required,
    })
    .strict()
    .refine(
      (v) =>
        v.total === undefined ||
        v.lines.reduce((n, l) => n + l.line_total, 0) <= v.total,
      { message: "Line totals cannot exceed order total" },
    ),
};
export type Dataset = keyof typeof schemas;
export const datasetNames = [
  "products",
  "shipping_zones",
  "faq",
  "policies",
  "orders",
] as const;
export function recordKey(dataset: Dataset, row: any) {
  return String(
    row[
      dataset === "products"
        ? "sku"
        : dataset === "shipping_zones"
          ? "zone_name"
          : dataset === "orders"
            ? "order_id"
            : "id"
    ],
  );
}
export function mapRows(
  dataset: Dataset,
  raw: Record<string, unknown>[],
  mapping: Record<string, string> = {},
) {
  const errors: { row: number; fields: string[]; message: string }[] = [];
  const rows: any[] = [];
  const keys = new Set<string>();
  raw.forEach((input, index) => {
    const mapped = Object.keys(mapping).length
      ? Object.fromEntries(
          Object.entries(mapping)
            .filter(([, v]) => v)
            .map(([field, col]) => [field, input[col]]),
        )
      : input;
    for (const k of Object.keys(mapped))
      if (mapped[k] === "" || mapped[k] === null) delete mapped[k];
    const r = schemas[dataset].safeParse(mapped);
    if (!r.success) {
      errors.push({
        row: index + 2,
        fields: r.error.issues.map((x) => x.path.join(".")),
        message: r.error.issues.map((x) => x.message).join("; "),
      });
      return;
    }
    const key = recordKey(dataset, r.data);
    if (keys.has(key)) {
      errors.push({
        row: index + 2,
        fields: [key],
        message: "Duplicate record key",
      });
      return;
    }
    keys.add(key);
    rows.push(r.data);
  });
  return { rows, errors };
}
