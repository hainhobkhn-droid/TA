import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { transaction, type PgPool } from "../db/index.js";
import { audit } from "../audit/index.js";
import { AppError } from "../errors.js";
import type { Actor } from "../auth/index.js";
const exec = promisify(execFile);
export function mediaPath(c: Config, key: string) {
  if (!/^[a-f0-9-]+(?:\.jpg|\.mp4)?$/.test(key))
    throw new Error("INVALID_STORAGE_KEY");
  return resolve(c.MEDIA_DIR, key);
}
export async function uploadMedia(
  pool: PgPool,
  c: Config,
  actor: Actor,
  stream: Readable,
  name: string,
  scope: string[],
) {
  const id = randomUUID();
  await mkdir(c.MEDIA_DIR, { recursive: true });
  const path = mediaPath(c, id);
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    await pipeline(
      stream,
      new Transform({
        transform(chunk, _enc, done) {
          bytes += chunk.length;
          if (bytes > c.MEDIA_MAX_BYTES)
            return done(new AppError(413, "MEDIA_TOO_LARGE"));
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    if (!bytes) throw new AppError(400, "EMPTY_MEDIA");
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO media_asset(id,business_id,uploaded_by,name,scope,storage_key,sha256,bytes) VALUES($1::uuid,$2,$3,$4,$5,$1::text,$6,$7)",
        [
          id,
          actor.businessId,
          actor.userId,
          name,
          scope,
          hash.digest("hex"),
          bytes,
        ],
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "media.uploaded",
        payload: { id, name, scope, bytes },
      });
    });
    return { id };
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
}
export async function inspectMedia(pool: PgPool, c: Config, id: string) {
  const r = await pool.query(
    "SELECT * FROM media_asset WHERE id=$1 AND status='processing'",
    [id],
  );
  if (!r.rowCount) return;
  const a = r.rows[0];
  try {
    const { stdout } = await exec(
      c.FFPROBE_PATH,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,image2,jpeg_pipe,png_pipe,webp_pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        mediaPath(c, a.storage_key),
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const probe = JSON.parse(stdout);
    const v = probe.streams?.find((s: any) => s.codec_type === "video");
    const audio = probe.streams?.find((s: any) => s.codec_type === "audio");
    if (!v) throw new Error("UNSUPPORTED_MEDIA");
    const image =
      ["mjpeg", "png", "webp"].includes(v.codec_name) &&
      !Number(probe.format.duration);
    if (
      !image &&
      !["h264", "hevc", "vp9", "av1", "mpeg4"].includes(v.codec_name)
    )
      throw new Error("UNSUPPORTED_MEDIA");
    const duration = Number(probe.format.duration ?? v.duration ?? 0);
    if (duration > c.MEDIA_MAX_DURATION)
      throw new Error("MEDIA_DURATION_LIMIT");
    const [n, d] = String(v.avg_frame_rate ?? "0/1")
      .split("/")
      .map(Number);
    const metadata = {
      width: v.width,
      height: v.height,
      duration,
      codec: v.codec_name,
      fps: d ? n / d : 0,
      audioCodec: audio?.codec_name,
      pixelFormat: v.pix_fmt,
    };
    const mime = image
      ? v.codec_name === "png"
        ? "image/png"
        : v.codec_name === "webp"
          ? "image/webp"
          : "image/jpeg"
      : "video/mp4";
    if (v.width * v.height > 4096 * 4096)
      throw new Error("MEDIA_RESOLUTION_LIMIT");
    await exec(
      c.FFMPEG_PATH,
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,image2,jpeg_pipe,png_pipe,webp_pipe",
        "-i",
        mediaPath(c, a.storage_key),
        "-frames:v",
        "1",
        "-vf",
        "scale=400:-2",
        "-threads",
        "1",
        "-y",
        mediaPath(c, id + ".jpg"),
      ],
      { timeout: 30000, maxBuffer: 65536 },
    );
    await pool.query(
      "UPDATE media_asset SET metadata=$2,mime=$3,status='ready' WHERE id=$1",
      [id, metadata, mime],
    );
  } catch (e) {
    const code =
      (e as any).code === "ENOENT"
        ? "FFMPEG_NOT_INSTALLED"
        : [
              "UNSUPPORTED_MEDIA",
              "MEDIA_DURATION_LIMIT",
              "MEDIA_RESOLUTION_LIMIT",
            ].includes((e as Error).message)
          ? (e as Error).message
          : "MEDIA_PROCESSING_FAILED";
    await pool.query(
      "UPDATE media_asset SET status='failed',error=$2 WHERE id=$1",
      [id, code],
    );
  }
}
export async function makeReel(pool: PgPool, c: Config, a: any, actor: Actor) {
  const id = randomUUID();
  const key = id + ".mp4";
  const path = mediaPath(c, key);
  try {
    await exec(
      c.FFMPEG_PATH,
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,image2,jpeg_pipe,png_pipe,webp_pipe",
        "-i",
        mediaPath(c, a.storage_key),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "60",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-threads",
        "1",
        "-y",
        path,
      ],
      { timeout: 600000, maxBuffer: 65536 },
    );
    const bytes = (await stat(path)).size;
    const h = createHash("sha256");
    for await (const b of createReadStream(path)) h.update(b);
    await transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO media_asset(id,business_id,uploaded_by,name,scope,storage_key,sha256,bytes,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          actor.businessId,
          actor.userId,
          `${a.name} — 9:16`,
          a.scope,
          key,
          h.digest("hex"),
          bytes,
          a.id,
        ],
      );
      await audit(db, {
        businessId: actor.businessId,
        actorId: actor.userId,
        action: "media.rendition_created",
        payload: { id, parentId: a.id },
      });
    });
    await inspectMedia(pool, c, id);
    return { id };
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
}
