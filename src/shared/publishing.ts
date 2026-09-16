import { z } from "zod";
export const variantSchema = z
  .object({
    channelId: z.string().uuid(),
    format: z.enum([
      "text",
      "photo",
      "multi_photo",
      "video",
      "reel",
      "tiktok_video",
    ]),
    caption: z.string().max(60000),
    hashtags: z
      .array(
        z
          .string()
          .regex(/^#[\p{L}\p{N}_]+$/u)
          .max(100),
      )
      .max(30)
      .default([]),
    firstComment: z.string().max(2000).default(""),
    mediaIds: z.array(z.string().uuid()).max(10).default([]),
    scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
    tiktok: z
      .object({
        mode: z.enum(["direct", "inbox", "manual"]),
        privacy: z
          .enum([
            "PUBLIC_TO_EVERYONE",
            "MUTUAL_FOLLOW_FRIENDS",
            "FOLLOWER_OF_CREATOR",
            "SELF_ONLY",
          ])
          .optional(),
        allowComment: z.boolean(),
        allowDuet: z.boolean(),
        allowStitch: z.boolean(),
        ownBrand: z.boolean(),
        paidPartnership: z.boolean(),
        aiGenerated: z.boolean(),
        consent: z.boolean(),
        musicRights: z.boolean(),
      })
      .optional(),
  })
  .strict();
export type VariantInput = z.infer<typeof variantSchema>;
export type MediaInfo = {
  id: string;
  sha256: string;
  bytes: number;
  mime: string;
  status: string;
  metadata: {
    width?: number;
    height?: number;
    duration?: number;
    codec?: string;
    fps?: number;
    audioCodec?: string;
  };
  name?: string;
};
export type PublishPayload = VariantInput & {
  media: MediaInfo[];
  platform: "facebook" | "tiktok";
  pageId: string | null;
  businessTimezone: "Asia/Ho_Chi_Minh";
};
export function businessInstant(local: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new Error("INVALID_BUSINESS_TIME");
  const d = new Date(local + ":00+07:00");
  if (
    !Number.isFinite(+d) ||
    new Date(+d + 7 * 3600000).toISOString().slice(0, 16) !== local
  )
    throw new Error("INVALID_BUSINESS_TIME");
  return d.toISOString();
}
export function businessLocal(iso: string) {
  return new Date(new Date(iso).getTime() + 7 * 3600000)
    .toISOString()
    .slice(0, 16);
}
export function validatePublish(p: PublishPayload): string[] {
  const errors: string[] = [];
  const m = p.media;
  if (m.some((x) => x.status !== "ready")) errors.push("MEDIA_NOT_READY");
  if (p.format === "text" && (!p.caption.trim() || m.length))
    errors.push("TEXT_REQUIRES_CAPTION_NO_MEDIA");
  if (
    p.format === "photo" &&
    (m.length !== 1 || !m[0]?.mime.startsWith("image/"))
  )
    errors.push("PHOTO_REQUIRES_ONE_IMAGE");
  if (
    p.format === "multi_photo" &&
    (m.length < 2 || m.some((x) => !x.mime.startsWith("image/")))
  )
    errors.push("MULTI_PHOTO_REQUIRES_IMAGES");
  if (
    ["video", "reel", "tiktok_video"].includes(p.format) &&
    (m.length !== 1 || !m[0]?.mime.startsWith("video/"))
  )
    errors.push("VIDEO_REQUIRED");
  if (p.platform === "facebook" && p.format === "tiktok_video")
    errors.push("FORMAT_CHANNEL_MISMATCH");
  if (p.platform === "tiktok" && p.format !== "tiktok_video")
    errors.push("TIKTOK_VIDEO_ONLY");
  if (p.platform === "tiktok" && p.firstComment)
    errors.push("FIRST_COMMENT_FACEBOOK_ONLY");
  if (
    p.platform === "tiktok" &&
    (p.caption + " " + p.hashtags.join(" ")).length > 2200
  )
    errors.push("TIKTOK_CAPTION_2200");
  if (p.format === "reel" && m[0]) {
    const v = m[0].metadata;
    if ((v.duration ?? 0) < 3 || (v.duration ?? 0) > 90)
      errors.push("REEL_DURATION_3_90");
    if (
      (v.width ?? 0) < 540 ||
      (v.height ?? 0) < 960 ||
      Math.abs((v.width ?? 0) / (v.height || 1) - 9 / 16) > 0.01
    )
      errors.push("REEL_VERTICAL_540_960");
    if ((v.fps ?? 0) < 24 || (v.fps ?? 0) > 60) errors.push("REEL_FPS_24_60");
    if (!["h264", "hevc", "vp9", "av1"].includes(v.codec ?? ""))
      errors.push("REEL_CODEC");
  }
  if (p.format === "tiktok_video" && m[0]) {
    const v = m[0].metadata;
    if ((v.fps ?? 0) < 23 || (v.fps ?? 0) > 60) errors.push("TIKTOK_FPS_23_60");
    if (
      (v.width ?? 0) < 360 ||
      (v.height ?? 0) < 360 ||
      (v.width ?? 0) > 4096 ||
      (v.height ?? 0) > 4096
    )
      errors.push("TIKTOK_SIZE_360_4096");
    if ((v.duration ?? 0) > 600) errors.push("TIKTOK_DURATION_600");
    if (!["h264", "hevc", "vp8", "vp9"].includes(v.codec ?? ""))
      errors.push("TIKTOK_CODEC");
  }
  return errors;
}
