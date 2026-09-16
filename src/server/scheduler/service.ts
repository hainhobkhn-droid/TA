import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type PgPool, type PoolClient } from "../db/index.js";
import { audit } from "../audit/index.js";
import { requirePermission, type Actor } from "../auth/index.js";
import { AppError } from "../errors.js";
import {
  variantSchema,
  validatePublish,
  type PublishPayload,
  type VariantInput,
} from "../../shared/publishing.js";
export const postSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    variants: z.array(variantSchema).min(1).max(10),
  })
  .strict();
export async function payloadFor(
  db: Pick<PgPool | PoolClient, "query">,
  actor: Actor,
  v: VariantInput,
): Promise<PublishPayload> {
  const ch = (
    await db.query("SELECT * FROM channel WHERE business_id=$1 AND id=$2", [
      actor.businessId,
      v.channelId,
    ])
  ).rows[0];
  if (!ch) throw new AppError(404, "CHANNEL_NOT_FOUND");
  requirePermission(actor, "posts.write", ch.platform);
  const media = (
    await db.query(
      "SELECT id,sha256,bytes::float,mime,status,metadata,name,scope FROM media_asset WHERE business_id=$1 AND id=ANY($2::uuid[])",
      [actor.businessId, v.mediaIds],
    )
  ).rows;
  if (
    new Set(v.mediaIds).size !== v.mediaIds.length ||
    media.length !== v.mediaIds.length ||
    media.some((m) => !m.scope.includes(ch.platform))
  )
    throw new AppError(400, "MEDIA_SCOPE_MISMATCH");
  const p: PublishPayload = {
    ...v,
    media: v.mediaIds.map((id) => {
      const { scope, ...safe } = media.find((m) => m.id === id);
      return safe;
    }),
    platform: ch.platform,
    pageId: ch.external_id,
    businessTimezone: "Asia/Ho_Chi_Minh",
  };
  return p;
}
export async function createPost(
  db: PoolClient,
  actor: Actor,
  input: z.infer<typeof postSchema>,
) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO post(id,business_id,title,created_by) VALUES($1,$2,$3,$4)",
    [id, actor.businessId, input.title, actor.userId],
  );
  const variants = [];
  for (const v of input.variants) {
    const payload = await payloadFor(db, actor, v);
    const variantId = randomUUID();
    if (v.scheduledAt) {
      const errors = validatePublish(payload);
      if (errors.length) throw new AppError(400, errors[0]);
    }
    await db.query(
      "INSERT INTO post_variant(id,business_id,post_id,channel_id,status,scheduled_at,scheduled_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        variantId,
        actor.businessId,
        id,
        v.channelId,
        v.scheduledAt ? "scheduled" : "draft",
        v.scheduledAt,
        v.scheduledAt ? actor.userId : null,
      ],
    );
    await db.query(
      "INSERT INTO post_revision(id,business_id,variant_id,revision,payload,created_by) VALUES($1,$2,$3,1,$4,$5)",
      [randomUUID(), actor.businessId, variantId, payload, actor.userId],
    );
    await audit(db, {
      businessId: actor.businessId,
      actorId: actor.userId,
      channelId: v.channelId,
      action: v.scheduledAt ? "post.scheduled" : "post.created",
      payload: { postId: id, variantId, revision: 1, exactPayload: payload },
    });
    variants.push(variantId);
  }
  return { id, variants };
}
export async function editVariant(
  pool: PgPool,
  actor: Actor,
  id: string,
  expected: number,
  input: VariantInput,
) {
  return transaction(pool, async (db) => {
    const v = (
      await db.query(
        "SELECT v.*,c.platform FROM post_variant v JOIN channel c ON c.id=v.channel_id WHERE v.business_id=$1 AND v.id=$2 FOR UPDATE OF v",
        [actor.businessId, id],
      )
    ).rows[0];
    if (!v) throw new AppError(404, "NOT_FOUND");
    requirePermission(actor, "posts.write", v.platform);
    if (v.revision !== expected) throw new AppError(409, "REVISION_CONFLICT");
    if (!["draft", "scheduled", "failed"].includes(v.status))
      throw new AppError(409, "DUPLICATE_TO_EDIT");
    if (input.channelId !== v.channel_id)
      throw new AppError(400, "CHANNEL_IMMUTABLE");
    const payload = await payloadFor(db, actor, input);
    if (input.scheduledAt) {
      const errors = validatePublish(payload);
      if (errors.length) throw new AppError(400, errors[0]);
    }
    const next = v.revision + 1;
    await db.query(
      "INSERT INTO post_revision(id,business_id,variant_id,revision,payload,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), actor.businessId, id, next, payload, actor.userId],
    );
    await db.query(
      "UPDATE post_variant SET revision=$3,status=$4,scheduled_at=$5,scheduled_by=$6,approved_revision=NULL,approved_by=NULL,error=NULL,updated_at=now() WHERE business_id=$1 AND id=$2",
      [
        actor.businessId,
        id,
        next,
        input.scheduledAt ? "scheduled" : "draft",
        input.scheduledAt,
        input.scheduledAt ? actor.userId : null,
      ],
    );
    await audit(db, {
      businessId: actor.businessId,
      actorId: actor.userId,
      channelId: v.channel_id,
      action: "post.revised",
      payload: { variantId: id, revision: next, exactPayload: payload },
    });
    return { revision: next };
  });
}
