import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readConfig } from "../config.js";
import { Pool } from "../db/index.js";
import { understand } from "../llm/gateway.js";
if (!process.argv.includes("--live-evaluation"))
  throw Error(
    "Pass --live-evaluation to use the configured provider and remaining monthly cap.",
  );
const c = readConfig();
const pool = new Pool({ connectionString: c.DATABASE_URL });
try {
  const business = (await pool.query("SELECT id FROM business")).rows[0];
  const channel = (
    await pool.query("SELECT id FROM channel WHERE business_id=$1 LIMIT 1", [
      business.id,
    ])
  ).rows[0];
  if (!channel) throw Error("Connect or create a channel first.");
  const cases = (
    await Promise.all(
      ["inquiries.vi.json", "inquiries.multilingual.json"].map(async (f) =>
        JSON.parse(await readFile("tests/fixtures/" + f, "utf8")),
      ),
    )
  ).flat();
  const results = [];
  for (const g of cases) {
    try {
      const result = await understand(pool, c, business.id, channel.id, g.text);
      results.push({
        id: g.id,
        expectedIntents: g.intents,
        predicted: result.data,
        exactIntentSet:
          JSON.stringify([...g.intents].sort()) ===
          JSON.stringify([...result.data.intents].sort()),
        callId: result.callId,
      });
    } catch {
      results.push({
        id: g.id,
        error: "EVALUATION_STOPPED_PROVIDER_OR_BUDGET",
      });
      break;
    }
  }
  const completed = results.filter((r) => !r.error);
  const summary = {
    generatedFixtureSetNotUserSignedOff: true,
    totalCases: cases.length,
    completed: completed.length,
    exactIntentAccuracy: completed.length
      ? completed.filter((r) => r.exactIntentSet).length / completed.length
      : null,
    perIntent: Object.fromEntries(
      [...new Set(cases.flatMap((g: any) => g.intents))].map((intent) => {
        const tp = completed.filter(
          (r) =>
            r.expectedIntents?.includes(intent) &&
            r.predicted?.intents.includes(intent as any),
        ).length;
        const expected = completed.filter((r) =>
          r.expectedIntents?.includes(intent),
        ).length;
        const predicted = completed.filter((r) =>
          r.predicted?.intents.includes(intent as any),
        ).length;
        return [
          String(intent),
          {
            truePositives: tp,
            expected,
            predicted,
            precision: predicted ? tp / predicted : null,
            recall: expected ? tp / expected : null,
          },
        ];
      }),
    ),
    results,
  };
  await mkdir(".local", { recursive: true });
  await writeFile(
    ".local/live-evaluation.json",
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      completed: summary.completed,
      totalCases: summary.totalCases,
      exactIntentAccuracy: summary.exactIntentAccuracy,
      output: ".local/live-evaluation.json",
    }),
  );
} finally {
  await pool.end();
}
