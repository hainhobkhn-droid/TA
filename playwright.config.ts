import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.e2e.ts",
  workers: 1,
  timeout: 60000,
  use: {
    actionTimeout: 10000,
    baseURL: "http://localhost:3101",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx tsx tests/e2e-server.ts",
    url: "http://localhost:3101/healthz",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
