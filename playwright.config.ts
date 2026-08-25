import { defineConfig } from "@playwright/test";

// Keep the test server away from common local development ports while letting
// isolated worktrees avoid a host-reserved port.
const port = Number(process.env.NARRAEON_E2E_PORT ?? 59_999);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  ...(process.env.NARRAEON_E2E_SELF_HOSTED === "1"
    ? {}
    : {
        webServer: {
          command: "node --experimental-strip-types src/server/main.ts",
          env: {
            NARRAEON_CONFIG_ROOT: ".test-data/e2e-config",
            NARRAEON_DATA_ROOT: ".test-data/e2e",
            NARRAEON_LOG_ROOT: ".test-data/e2e-log",
            NARRAEON_PORT: String(port),
            NODE_ENV: "test",
          },
          url: `http://127.0.0.1:${port}/health`,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
