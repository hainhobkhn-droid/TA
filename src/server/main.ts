import { readConfig } from "./config.js";
import { buildApp } from "./app.js";
const config = readConfig();
const { app } = await buildApp(config);
await app.listen({ port: config.PORT, host: "0.0.0.0" });
process.on("SIGTERM", () => void app.close());
process.on("SIGINT", () => void app.close());
