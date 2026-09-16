import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  ENCRYPTION_KEY_ID: z.string().min(1).default("v1"),
  BOOTSTRAP_TOKEN: z.string().min(32),
  HELPA_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("anthropic"),
  LLM_MODEL: z.string().default(""),
  LLM_MONTHLY_CAP_USD: z.coerce.number().min(0).max(100000).default(0),
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().default(""),
  KNOWLEDGE_POLL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  AUDIENCE_METRICS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AUTH_DELIVERY_MODE: z
    .enum(["disabled", "console", "live"])
    .default("disabled"),
  AUTH_DEV_OUTBOX: z.string().default(".local/auth-outbox"),
  TWILIO_ACCOUNT_SID: z
    .string()
    .regex(/^$|^AC[0-9a-fA-F]{32}$/)
    .default(""),
  TWILIO_MESSAGE_FROM: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_VERIFY_SERVICE_SID: z
    .string()
    .regex(/^$|^VA[0-9a-fA-F]{32}$/)
    .default(""),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM: z.string().default(""),
  NOTIFICATION_MODE: z.enum(["dry_run", "live"]).default("dry_run"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.0$/)
    .default("v25.0"),
  TIKTOK_CLIENT_KEY: z.string().default(""),
  TIKTOK_CLIENT_SECRET: z.string().default(""),
  TIKTOK_DIRECT_POST_ELIGIBILITY: z
    .enum(["unverified", "approved"])
    .default("unverified"),
  TIKTOK_URL_OWNERSHIP_VERIFIED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MEDIA_DIR: z.string().default("media"),
  MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(536870912)
    .default(104857600),
  MEDIA_MAX_DURATION: z.coerce.number().positive().max(3600).default(600),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info"),
});

export type Config = z.infer<typeof schema>;
export function readConfig(env: Record<string, unknown> = process.env): Config {
  const c = schema.parse(env);
  const url = new URL(c.PUBLIC_URL);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "PUBLIC_URL must be an origin without path, credentials or query",
    );
  if (c.NODE_ENV === "production" && url.protocol !== "https:")
    throw new Error("Production PUBLIC_URL must use HTTPS");
  return { ...c, PUBLIC_URL: url.origin };
}
