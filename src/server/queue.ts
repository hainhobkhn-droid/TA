import { PgBoss } from "pg-boss";
import type { Config } from "./config.js";
export const probeQueue = "helpa-dry-run-probe";
export async function startQueue(c: Config) {
  const boss = new PgBoss({ connectionString: c.DATABASE_URL, max: 3 });
  boss.on("error", () =>
    console.error(JSON.stringify({ level: "error", event: "queue_error" })),
  );
  await boss.start();
  await boss.createQueue(probeQueue, {
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
  });
  await boss.createQueue("helpa-media-rendition", { retryLimit: 0 });
  return boss;
}
