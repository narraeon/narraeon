import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Persistence tests exercise real disk writes, restarts, and world forks.
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
