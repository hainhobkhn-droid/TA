import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PgPool } from "../db/index.js";
import { actorFor, requirePermission, type Auth } from "../auth/index.js";
export function csvCell(value: unknown) {
  const s =
    typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return (
    '"' +
    (/^[\s]*[=+\-@\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') +
    '"'
  );
}
export async function auditRoutes(
  app: FastifyInstance,
  pool: PgPool,
  auth: Auth,
) {
  for (const format of ["json", "csv"])
    app.get(
      format === "csv" ? "/api/audit/export" : "/api/audit",
      async (req, reply) => {
        const a = await actorFor(auth, pool, req);
        requirePermission(a, "audit.read");
        const q = z
          .object({
            action: z.string().max(100).default(""),
            actorId: z.string().max(100).default(""),
            channelId: z.string().uuid().optional(),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(format === "csv" ? 10000 : 100)
              .default(format === "csv" ? 10000 : 50),
          })
          .parse(req.query);
        const r = await pool.query(
          `SELECT a.id,a.actor_id,a.actor_type,a.action,a.payload,a.created_at,c.display_name AS channel FROM audit_event a LEFT JOIN channel c ON c.id=a.channel_id AND c.business_id=a.business_id WHERE a.business_id=$1 AND ($2 OR c.platform=ANY($3::text[]) OR a.channel_id IS NULL) AND ($4='' OR a.action=$4) AND ($5='' OR a.actor_id=$5) AND ($6::uuid IS NULL OR a.channel_id=$6) AND ($7::timestamptz IS NULL OR a.created_at>=$7) AND ($8::timestamptz IS NULL OR a.created_at<$8) ORDER BY a.created_at DESC LIMIT $9`,
          [
            a.businessId,
            a.channelScope.includes("*"),
            a.channelScope,
            q.action,
            q.actorId,
            q.channelId ?? null,
            q.from ?? null,
            q.to ?? null,
            q.limit,
          ],
        );
        if (format === "json") return { events: r.rows };
        const columns = [
          "id",
          "actor_id",
          "actor_type",
          "action",
          "channel",
          "created_at",
          "payload",
        ];
        return reply
          .header(
            "content-disposition",
            'attachment; filename="helpa-audit.csv"',
          )
          .type("text/csv; charset=utf-8")
          .send(
            "\uFEFF" +
              [
                columns.join(","),
                ...r.rows.map((row) =>
                  columns
                    .map((k) =>
                      csvCell(
                        row[k] instanceof Date ? row[k].toISOString() : row[k],
                      ),
                    )
                    .join(","),
                ),
              ].join("\r\n"),
          );
      },
    );
}
