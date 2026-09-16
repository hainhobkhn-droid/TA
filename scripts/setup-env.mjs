import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const local = process.argv.includes("--local");
let text = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const password = randomBytes(24).toString("hex");
const values = {
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgresql://helpa:${password}@${local ? "127.0.0.1:54329" : "postgres:5432"}/helpa`,
  AUTH_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  BOOTSTRAP_TOKEN: randomBytes(32).toString("hex"),
  ...(local
    ? { NODE_ENV: "development", PUBLIC_URL: "http://localhost:3000" }
    : {}),
};
for (const [key, value] of Object.entries(values))
  text = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
try {
  await writeFile(".env", text, { flag: "wx", mode: 0o600 });
  console.log(
    "Created private .env. Read BOOTSTRAP_TOKEN there for first owner setup. Existing files are never overwritten.",
  );
} catch (e) {
  if (e.code === "EEXIST") {
    console.error(".env already exists; left unchanged.");
    process.exitCode = 1;
  } else throw e;
}
