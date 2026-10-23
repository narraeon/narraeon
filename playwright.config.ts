import { defineConfig } from "@playwright/test";

// Keep the test server away from common local development ports while letting
// isolated worktrees avoid a host-reserved port.
const port = Number(process.env.NARRAEON_E2E_PORT ?? 59_999);
const dataRoot = ".test-data/e2e";
const configRoot = ".test-data/e2e-config";
const logRoot = ".test-data/e2e-log";

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
          // The reset runs before the server starts; globalSetup would run
          // after webServer and could delete data under a live server.
          command: [
            `node scripts/reset-e2e-data.mjs ${dataRoot} ${configRoot} ${logRoot}`,
            "node --experimental-strip-types src/server/main.ts",
          ].join(" && "),
          env: {
            NARRAEON_CONFIG_ROOT: configRoot,
            NARRAEON_DATA_ROOT: dataRoot,
            NARRAEON_LOG_ROOT: logRoot,
            NARRAEON_PORT: String(port),
            NODE_ENV: "test",
          },
          url: `http://127.0.0.1:${port}/health`,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
